import { Button } from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { navigate } from "./api.ts";
import { Brand, GITHUB_URL, SiteFooter } from "./Profile.tsx";

const CONTACT_EMAIL = "huynhduongsh1@gmail.com";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-kumo-strong">{title}</h2>
      {children}
    </section>
  );
}

const linkClass = "text-kumo-link underline";

/**
 * The privacy policy. Google needs it on the same domain as the home page before it shows the
 * app name and logo on its sign-in page. It must stay true to what the code does.
 */
export function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-kumo-hairline">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-6">
          <a
            href="/"
            aria-label="draw home page"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            <Brand />
          </a>
          <Button variant="ghost" icon={ArrowLeftIcon} onClick={() => navigate("/")}>
            Back to the app
          </Button>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10 leading-relaxed text-kumo-default">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-kumo-strong">Privacy policy</h1>
          <p className="text-sm text-kumo-subtle">Last updated: 22 November 2026</p>
        </div>
        <p>
          draw is an Excalidraw editor with a project list, autosave, a version history and
          branches. This page tells which data draw keeps, why, and how you can remove it. draw is a
          personal open-source project by betty2310. The{" "}
          <a href={GITHUB_URL} className={linkClass}>
            source code
          </a>{" "}
          is public, so you can check each statement on this page.
        </p>

        <Section title="Data from your Google account">
          <p>
            You sign in with Google. draw asks Google only for the scopes <code>openid</code>,{" "}
            <code>email</code> and <code>profile</code>. From these, draw keeps:
          </p>
          <ul className="list-disc space-y-1 pl-6">
            <li>your Google account ID, to find your account at the next sign-in,</li>
            <li>your name, which shows on each version that you save,</li>
            <li>your email address, which shows in the account menu,</li>
            <li>the address of your profile picture, which shows in the account menu.</li>
          </ul>
          <p>
            draw does not keep Google access tokens or refresh tokens. It does not read your Gmail,
            your Drive, your contacts or other Google data. After each sign-in, draw updates your
            name, email address and picture from Google.
          </p>
          <p>
            draw's use of information received from Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className={linkClass}
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </Section>

        <Section title="Your drawings">
          <p>
            draw keeps your projects, their versions, branches and pasted images, so that you can
            open them again. Only you can open the projects of your workspace. Versions with no name
            are deleted 30 days after their last save. Named versions stay until you delete their
            branch.
          </p>
        </Section>

        <Section title="Cookies and data in your browser">
          <ul className="list-disc space-y-1 pl-6">
            <li>
              A session cookie keeps you signed in for 30 days. draw keeps only a hash of it. Sign
              out deletes the session.
            </li>
            <li>A short cookie (10 minutes) protects the sign-in with Google.</li>
            <li>
              Your browser keeps a copy of your drawings and images (IndexedDB) and your name, email
              address and picture (localStorage), so that you can draw offline.
            </li>
          </ul>
          <p>draw has no advertising, no analytics and no tracking cookies.</p>
        </Section>

        <Section title="Where the data is">
          <p>
            draw runs on{" "}
            <a href="https://www.cloudflare.com/privacypolicy/" className={linkClass}>
              Cloudflare
            </a>{" "}
            Workers. Your account and project list are in a Cloudflare D1 database. Your drawings
            are in Cloudflare Durable Objects. Cloudflare keeps request logs for a short time to run
            the service. Google handles the sign-in under the{" "}
            <a href="https://policies.google.com/privacy" className={linkClass}>
              Google Privacy Policy
            </a>
            .
          </p>
          <p>draw does not sell, rent or share your data with other parties.</p>
        </Section>

        <Section title="Remove your data">
          <p>
            Send an email to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass}>
              {CONTACT_EMAIL}
            </a>{" "}
            from the address of your account. Your account, your sessions and your projects are then
            deleted. You can also remove the access of draw at{" "}
            <a href="https://myaccount.google.com/connections" className={linkClass}>
              myaccount.google.com/connections
            </a>
            .
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If this policy changes, this page shows the new text and the date of the change. For
            questions, send an email to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>
      </main>
      <SiteFooter />
    </div>
  );
}
