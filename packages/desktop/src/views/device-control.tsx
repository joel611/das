import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { StateBadge } from "@/components/state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ago } from "@/lib/format";
import { useCameraStream, useDevices, useSignalDevice } from "@/lib/queries";
import type { CameraFrame, Device, DeviceSignal, LightSpec, SessionState } from "@/lib/types";

const STATES: SessionState[] = ["error", "waiting", "running", "done", "idle"];
// M5StackChan neck limits (DEVICE.md): pan ±128°, tilt 5° to 85° up; it cannot look down.
const YAW_MAX = 128;
const PITCH_MIN = 5;
const PITCH_MAX = 85;
const one = (v: number | readonly number[]) => (typeof v === "number" ? v : (v[0] ?? 0));

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

function useSend(d: Device) {
  const signal = useSignalDevice();
  return (s: DeviceSignal) =>
    signal.mutate({ id: d.id, signal: s }, { onError: (e) => toast.error(e.message) });
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function SliderRow({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-sm">
        <Label>{label}</Label>
        <span className="text-muted-foreground tabular-nums">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(one(v))}
        onValueCommitted={onCommit ? (v) => onCommit(one(v)) : undefined}
      />
    </div>
  );
}

function LightSection({ d }: { d: Device }) {
  const send = useSend(d);
  const [color, setColor] = useState("#00ff00");
  const [period, setPeriod] = useState(1000);
  const rgb = hexToRgb(color);
  const light = (l: LightSpec) => send({ light: l });
  return (
    <Section title="Light" description="LED ring. The next session change overrides it.">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label="Light colour"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-8 w-12 cursor-pointer rounded border bg-transparent"
        />
        <Button size="sm" variant="outline" onClick={() => light({ mode: "solid", rgb })}>
          Solid
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => light({ mode: "blink", rgb, periodMs: period })}
        >
          Blink
        </Button>
        <Button size="sm" variant="outline" onClick={() => light({ mode: "rainbow" })}>
          Rainbow
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => light({ mode: "solid", rgb: [0, 0, 0] })}
        >
          Off
        </Button>
      </div>
      <SliderRow
        label="Blink period"
        value={period}
        unit=" ms"
        min={100}
        max={3000}
        step={100}
        onChange={setPeriod}
      />
      {d.capabilities.includes("screen") ? (
        <div className="flex flex-col gap-2">
          <Label>Show session state (face + light)</Label>
          <div className="flex flex-wrap gap-2">
            {STATES.map((s) => (
              <button
                key={s}
                type="button"
                className="cursor-pointer"
                onClick={() => send({ state: s })}
              >
                <StateBadge state={s} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function AudioSection({ d }: { d: Device }) {
  const send = useSend(d);
  const [hz, setHz] = useState(660);
  const [ms, setMs] = useState(200);
  const [text, setText] = useState("");
  const say = () => {
    if (!text.trim()) return;
    send({ say: text });
  };
  return (
    <Section title="Audio" description="Speak text or play a tone on the speaker.">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          say();
        }}
      >
        <Input
          value={text}
          maxLength={200}
          placeholder="Text to say"
          aria-label="Text to say"
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Say
        </Button>
      </form>
      <SliderRow
        label="Pitch"
        value={hz}
        unit=" Hz"
        min={100}
        max={2000}
        step={10}
        onChange={setHz}
      />
      <SliderRow
        label="Length"
        value={ms}
        unit=" ms"
        min={50}
        max={2000}
        step={50}
        onChange={setMs}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => send({ sound: { hz, ms } })}>
          Play tone
        </Button>
        <Button size="sm" variant="outline" onClick={() => send({ sound: { hz: 660, ms: 200 } })}>
          Beep
        </Button>
      </div>
    </Section>
  );
}

/** Paints an RGB332 frame; the canvas is sized to the frame and scaled up by CSS. */
function FrameCanvas({ frame }: { frame: NonNullable<CameraFrame> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const src = Uint8Array.from(atob(frame.rgb332), (c) => c.charCodeAt(0));
    const img = ctx.createImageData(frame.w, frame.h);
    for (let i = 0; i < frame.w * frame.h; i++) {
      const p = src[i]; // RRRGGGBB
      img.data[4 * i] = (((p >> 5) & 7) * 255) / 7;
      img.data[4 * i + 1] = (((p >> 2) & 7) * 255) / 7;
      img.data[4 * i + 2] = ((p & 3) * 255) / 3;
      img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [frame]);
  return (
    <canvas
      ref={ref}
      width={frame.w}
      height={frame.h}
      aria-label="Stack-chan camera"
      className="size-full object-contain [image-rendering:pixelated]"
    />
  );
}

function CameraSection({ d }: { d: Device }) {
  const send = useSend(d);
  const [on, setOn] = useState(false);
  const { frame, error } = useCameraStream(d.id, on);
  const toggle = (next: boolean) => {
    setOn(next);
    send({ camera: next });
  };
  return (
    <Section
      title="Camera"
      description="Live preview, pushed from the device as fast as it can capture."
    >
      <div className="flex items-center gap-2">
        <Switch checked={on} onCheckedChange={toggle} aria-label="Stream camera" />
        <Label>{on ? "Streaming" : "Off"}</Label>
        {on && frame ? <Badge variant="outline">updated {ago(frame.at)}</Badge> : null}
        {on && error ? <Badge variant="destructive">{error}</Badge> : null}
      </div>
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md border bg-muted text-sm text-muted-foreground">
        {on && frame ? (
          <FrameCanvas frame={frame} />
        ) : on ? (
          "Waiting for first frame…"
        ) : (
          "Camera off"
        )}
      </div>
    </Section>
  );
}

function ServoSection({ d }: { d: Device }) {
  const send = useSend(d);
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(PITCH_MIN);
  const move = (y: number, p: number) => send({ servo: { yaw: y, pitch: p } });
  return (
    <Section title="Servo" description="Neck pose. Moves when you release the slider.">
      <SliderRow
        label="Pan (left +)"
        value={yaw}
        unit="°"
        min={-YAW_MAX}
        max={YAW_MAX}
        onChange={setYaw}
        onCommit={(v) => move(v, pitch)}
      />
      <SliderRow
        label="Tilt (up +)"
        value={pitch}
        unit="°"
        min={PITCH_MIN}
        max={PITCH_MAX}
        onChange={setPitch}
        onCommit={(v) => move(yaw, v)}
      />
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setYaw(0);
            setPitch(PITCH_MIN);
            move(0, PITCH_MIN);
          }}
        >
          Center
        </Button>
      </div>
    </Section>
  );
}

/** Direct controls for the (single) connected device. Sections follow its declared capabilities. */
export function DeviceControl() {
  const devices = useDevices();
  const d = devices.data?.[0];

  if (!d)
    return (
      <Card>
        <CardHeader>
          <CardTitle>No device connected</CardTitle>
          <CardDescription>
            Controls appear when Stack-chan connects over WebSocket.
          </CardDescription>
        </CardHeader>
      </Card>
    );

  const has = (c: string) => d.capabilities.includes(c);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{d.device}</h2>
        <span className="text-sm text-muted-foreground">connected {ago(d.connectedAt)}</span>
        {d.capabilities.map((c) => (
          <Badge key={c} variant="outline">
            {c}
          </Badge>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {has("light") || has("screen") ? <LightSection d={d} /> : null}
        {has("speaker") ? <AudioSection d={d} /> : null}
        {has("camera") ? <CameraSection d={d} /> : null}
        {has("servo") ? <ServoSection d={d} /> : null}
      </div>
    </div>
  );
}
