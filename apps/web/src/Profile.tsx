import { Button, Dialog, Input, LayerCard } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  ClockCounterClockwiseIcon,
  CloudCheckIcon,
  GitBranchIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { getAuthor, getEmail, setAuthor, setEmail } from "./api.ts";

/** The person who uses this browser. The name is the author of each version. */
export interface Profile {
  name: string;
  email: string;
}

export const loadProfile = (): Profile => ({ name: getAuthor(), email: getEmail() });

export function saveProfile(profile: Profile) {
  setAuthor(profile.name);
  setEmail(profile.email);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** A circle with the initials of the name. Each name gets its own color. */
export function Avatar({ name }: { name: string }) {
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

/** The display name and the optional email. */
function ProfileForm({
  initial,
  submitLabel,
  onSubmit,
  cancel,
}: {
  initial: Profile;
  submitLabel: string;
  onSubmit: (profile: Profile) => void;
  /** A dialog has a cancel button, and its buttons are at the right. */
  cancel?: ReactNode;
}) {
  const [name, setName] = useState(initial.name);
  const [email, setEmailValue] = useState(initial.email);
  const [checkEmail, setCheckEmail] = useState(false);
  const emailValid = !email.trim() || EMAIL_PATTERN.test(email.trim());
  const emailError =
    checkEmail && !emailValid ? "Type a valid email address, or leave it empty." : undefined;

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        if (!emailValid) return setCheckEmail(true);
        onSubmit({ name: name.trim(), email: email.trim() });
      }}
    >
      <Input
        label="Display name"
        description="Others see this name on each version that you save."
        placeholder="For example, Minh Anh"
        autoComplete="name"
        autoFocus
        maxLength={100}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        label="Email"
        required={false}
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        description="Only this browser keeps it."
        maxLength={200}
        value={email}
        error={emailError}
        onChange={(event) => setEmailValue(event.target.value)}
        onBlur={() => setCheckEmail(true)}
      />
      {cancel ? (
        <div className="flex justify-end gap-2">
          {cancel}
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {submitLabel}
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="mt-1 w-full"
          disabled={!name.trim()}
        >
          {submitLabel}
          <ArrowRightIcon weight="bold" />
        </Button>
      )}
    </form>
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

/** The first page. It asks for the display name before the app opens. */
export function WelcomePage({ onDone }: { onDone: (profile: Profile) => void }) {
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
              Draw in the Excalidraw editor with your team. No account is necessary.
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
              <h2 className="text-xl font-semibold text-kumo-strong">What is your name?</h2>
              <p className="text-sm text-kumo-subtle">
                This browser keeps your name. You can change it later.
              </p>
            </div>
            <ProfileForm
              initial={{ name: "", email: "" }}
              submitLabel="Continue"
              onSubmit={onDone}
            />
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </main>
  );
}

/** Changes the display name and the email. */
export function ProfileDialog({
  profile,
  onSave,
  onClose,
}: {
  profile: Profile;
  onSave: (profile: Profile) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => !isOpen && onClose()}
    >
      <Dialog size="lg" className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold">Your profile</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            A new name shows on the versions that you save after the change.
          </Dialog.Description>
        </div>
        <ProfileForm
          initial={profile}
          submitLabel="Save"
          onSubmit={(next) => {
            onSave(next);
            setOpen(false);
          }}
          cancel={<Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />}
        />
      </Dialog>
    </Dialog.Root>
  );
}
