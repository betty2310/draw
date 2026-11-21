import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import {
  ClockCounterClockwiseIcon,
  CloudCheckIcon,
  GitBranchIcon,
  GoogleLogoIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { signInUrl } from "./api.ts";

/** The mascot from the app icon: the cat with a pencil in its mouth. */
export function Mascot({ className }: { className?: string }) {
  return <img src="/mascot.webp" alt="" draggable={false} className={className} />;
}

/** The logo and the app name. */
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className="flex items-end gap-2">
      <Mascot className={large ? "h-16 w-auto" : "h-10 w-auto"} />
      <span
        className={
          (large ? "pb-1.5 text-2xl" : "pb-1 text-xl") +
          " font-semibold tracking-tight text-kumo-strong"
        }
      >
        draw
      </span>
    </span>
  );
}

// Vietnamese initials can have combining marks, so a letter is a grapheme, not a code point.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The Google picture, or a circle with the initials of the name. Each name gets its own color. */
export function Avatar({ name, picture }: { name: string; picture?: string }) {
  const [broken, setBroken] = useState(false);
  if (picture && !broken) {
    return (
      <img
        src={picture}
        alt=""
        // Google refuses some picture requests that carry a referrer.
        referrerPolicy="no-referrer"
        className="size-7 shrink-0 rounded-full object-cover"
        onError={() => setBroken(true)}
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => graphemes.segment(word)[Symbol.iterator]().next().value?.segment ?? "")
    .join("")
    .toUpperCase();
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.codePointAt(0)!) % 360;
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold"
      style={{ background: `oklch(0.9 0.06 ${hue})`, color: `oklch(0.38 0.1 ${hue})` }}
    >
      {initials}
    </span>
  );
}

const FEATURES: { icon: Icon; title: string; text: string }[] = [
  {
    icon: CloudCheckIcon,
    title: "Autosave",
    text: "Each change is saved. You can also draw offline.",
  },
  {
    icon: ClockCounterClockwiseIcon,
    title: "Version history",
    text: "Give a name to a version, see it again, or restore it.",
  },
  {
    icon: GitBranchIcon,
    title: "Branches",
    text: "Try an idea on a branch. The main drawing does not change.",
  },
];

/** The first page, for a browser with no session. `next` is the page to open after the sign-in. */
export function WelcomePage({ next, failed }: { next: string; failed: boolean }) {
  return (
    <main className="welcome min-h-screen">
      <div className="mx-auto grid min-h-screen max-w-5xl items-center gap-12 px-6 py-12 lg:grid-cols-[1fr_26rem] lg:gap-16">
        <section className="flex flex-col gap-10">
          <Brand large />
          <div className="flex flex-col gap-4">
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-kumo-strong sm:text-5xl">
              Diagrams that keep their history.
            </h1>
            <p className="max-w-md text-lg text-kumo-subtle">
              Draw in the Excalidraw editor. Your projects are in your own workspace.
            </p>
          </div>
          <ul className="hidden flex-col gap-5 sm:flex">
            {FEATURES.map(({ icon: FeatureIcon, title, text }) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-kumo-base text-kumo-default ring ring-kumo-line">
                  <FeatureIcon size={18} />
                </span>
                <span className="flex flex-col">
                  <span className="font-medium text-kumo-default">{title}</span>
                  <span className="text-sm text-kumo-subtle">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <LayerCard className="shadow-lg">
          <LayerCard.Secondary>Before you start</LayerCard.Secondary>
          <LayerCard.Primary className="flex flex-col gap-6 p-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-xl font-semibold text-kumo-strong">Sign in</h2>
              <p className="text-sm text-kumo-subtle">
                Use your Google account. The app gets only your name, email address and picture.
                Your name shows on each version that you save.
              </p>
            </div>
            {failed && (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                title="The sign-in did not complete"
                description="Try again."
              />
            )}
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              icon={<GoogleLogoIcon weight="bold" />}
              onClick={() => location.assign(signInUrl(next))}
            >
              Sign in with Google
            </Button>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </main>
  );
}
