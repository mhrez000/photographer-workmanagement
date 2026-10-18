import Image from "next/image";
import { DesktopFrame, PhoneFrame } from "./device-frame";
import { Section } from "./section";

export function Screenshots() {
  return (
    <Section id="screens" eyebrow="A look inside" heading="Calm screens that say what to do next.">
      <div className="mt-10 flex flex-col gap-10 sm:mt-12 sm:gap-14">
        <DesktopFrame
          title="Job — 8 Penrose Street · Listing photos"
          caption="The job page. A Next step card at the top, the files, the editor's instructions, messages, and who did what."
        >
          <Image
            src="/marketing/job-desktop.png"
            alt="A job page in Proofline. The job is Ready to check and waiting on you. A highlighted Next step card offers Open finished photos, Approve and Ask for changes, above the Files, Instructions for the editor and Messages sections."
            width={1200}
            height={633}
            loading="lazy"
            sizes="(min-width: 1120px) 1056px, 100vw"
            className="block h-auto w-full"
          />
        </DesktopFrame>

        <div className="grid items-start gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:gap-8">
          <DesktopFrame
            title="My jobs — Sam Whitfield"
            caption="What an editor sees: only their jobs, changes first, and a Send for checking button on each."
          >
            <Image
              src="/marketing/my-jobs-desktop.png"
              alt="The editor's My jobs screen. A banner says what is next up, then cards for each job with the photographer's change request quoted and a Send for checking button."
              width={1200}
              height={417}
              loading="lazy"
              sizes="(min-width: 768px) 720px, 100vw"
              className="block h-auto w-full"
            />
          </DesktopFrame>
          <PhoneFrame caption="Home on a phone. The same three counts and the same buttons.">
            <Image
              src="/marketing/home-mobile.png"
              alt="Proofline Home on a phone: a greeting, counts of jobs to check, late and needing an editor, a New job button and the list of jobs ready to check."
              width={390}
              height={770}
              loading="lazy"
              sizes="300px"
              className="block h-auto w-full"
            />
          </PhoneFrame>
        </div>
      </div>
    </Section>
  );
}
