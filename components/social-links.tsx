import { LINKS } from "@/lib/links";
import { SOCIAL_GLYPHS, type SocialGlyph } from "@/lib/social-glyphs";

type Social = SocialGlyph & {
  label: string;
  href: string;
};

const SOCIALS: Social[] = [
  { label: "X", href: LINKS.x, ...SOCIAL_GLYPHS.x },
  { label: "LinkedIn", href: LINKS.linkedin, ...SOCIAL_GLYPHS.linkedin },
  { label: "Instagram", href: LINKS.instagram, ...SOCIAL_GLYPHS.instagram },
  { label: "WhatsApp", href: LINKS.whatsapp, ...SOCIAL_GLYPHS.whatsapp },
  { label: "Telegram", href: LINKS.telegram, ...SOCIAL_GLYPHS.telegram },
];

export function SocialLinks() {
  return (
    <div className="flex items-center gap-[22px]">
      {SOCIALS.map(({ label, href, path, viewBox }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`${label} (opens in new tab)`}
          className="-m-2.5 flex p-2.5 text-ink transition-colors duration-200 hover:text-orange focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <svg
            width="22"
            height="22"
            viewBox={viewBox}
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d={path} />
          </svg>
        </a>
      ))}
    </div>
  );
}
