import sharp from 'sharp';

import type { CakeDayAnnouncement } from '../services/cake-days.js';

const CARD_WIDTH = 900;
const CARD_HEIGHT = 280;
const FONT_FAMILY = 'DejaVu Sans, sans-serif';

export async function buildCakeDayCard(
  announcement: Pick<CakeDayAnnouncement, 'displayName' | 'years' | 'avatarUrl'>,
): Promise<Buffer> {
  const avatarDataUri = announcement.avatarUrl
    ? await fetchDiscordAvatarDataUri(announcement.avatarUrl)
    : undefined;

  return sharp(Buffer.from(buildCakeDayCardSvg(announcement, avatarDataUri)))
    .png()
    .toBuffer();
}

export function buildCakeDayCardSvg(
  announcement: Pick<CakeDayAnnouncement, 'displayName' | 'years'>,
  avatarDataUri?: string,
): string {
  const displayName = announcement.displayName.trim() || 'STEMCraft member';
  const safeName = escapeSvgText(truncateDisplayName(displayName));
  const safeInitials = escapeSvgText(getUserInitials(displayName));
  const years = Math.max(1, Math.floor(announcement.years));
  const yearLabel = `${years} ${years === 1 ? 'YEAR' : 'YEARS'} IN THE STEMMECHANICS COMMUNITY`;
  const safeYearLabel = escapeSvgText(yearLabel);
  const avatar = avatarDataUri
    ? `<clipPath id="avatar-clip"><circle cx="104" cy="126" r="70" /></clipPath><image href="${avatarDataUri}" x="34" y="56" width="140" height="140" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)" />`
    : `<circle cx="104" cy="126" r="70" fill="#5865f2" /><text x="104" y="142" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="44" font-weight="700" fill="#ffffff">${safeInitials}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="card" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07152f" />
      <stop offset="1" stop-color="#172b4d" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#55d6f5" />
      <stop offset="1" stop-color="#8b8cff" />
    </linearGradient>
    <linearGradient id="robot-body" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f9fcff" />
      <stop offset="1" stop-color="#b7c9df" />
    </linearGradient>
  </defs>
  <rect width="900" height="280" rx="18" fill="url(#card)" />
  <path d="M0 232C160 190 280 262 430 230s270-2 470-50v100H0Z" fill="#0d2143" opacity="0.7" />
  <path d="M20 44h120M744 34h120M742 246h116" stroke="#55d6f5" stroke-width="2" opacity="0.25" />
  <path d="M184 24l42 28M214 24l-30 42M790 92l42 28M818 86l-30 42" stroke="#8b8cff" stroke-width="2" opacity="0.28" />
  <circle cx="174" cy="35" r="3" fill="#55d6f5" />
  <circle cx="226" cy="51" r="3" fill="#8b8cff" />
  <circle cx="786" cy="91" r="3" fill="#55d6f5" />
  <circle cx="832" cy="120" r="3" fill="#8b8cff" />
  <circle cx="30" cy="218" r="3" fill="#ffcc66" />
  <circle cx="250" cy="246" r="3" fill="#ff8fb1" />
  <circle cx="700" cy="238" r="3" fill="#55d6f5" />
  <circle cx="866" cy="210" r="3" fill="#ffcc66" />
  <circle cx="104" cy="126" r="76" fill="none" stroke="url(#accent)" stroke-width="4" opacity="0.9" />
  ${avatar}

  <g aria-label="friendly STEM robot">
    <path d="M330 74V51" stroke="#b7c9df" stroke-width="5" stroke-linecap="round" />
    <circle cx="330" cy="43" r="8" fill="#ffcc66" stroke="#fff2b5" stroke-width="3" />
    <rect x="281" y="74" width="98" height="74" rx="22" fill="url(#robot-body)" />
    <rect x="297" y="91" width="66" height="34" rx="11" fill="#172b4d" />
    <circle cx="316" cy="107" r="5" fill="#55d6f5" />
    <circle cx="344" cy="107" r="5" fill="#55d6f5" />
    <path d="M316 119q14 10 28 0" fill="none" stroke="#8b8cff" stroke-width="3" stroke-linecap="round" />
    <circle cx="274" cy="105" r="7" fill="#ff8fb1" />
    <circle cx="386" cy="105" r="7" fill="#ff8fb1" />
    <rect x="267" y="146" width="126" height="77" rx="19" fill="url(#robot-body)" />
    <circle cx="330" cy="181" r="20" fill="#172b4d" />
    <ellipse cx="330" cy="181" rx="10" ry="20" fill="none" stroke="#55d6f5" stroke-width="2" />
    <ellipse cx="330" cy="181" rx="20" ry="8" fill="none" stroke="#8b8cff" stroke-width="2" />
    <circle cx="330" cy="181" r="4" fill="#ffcc66" />
    <path d="M267 160h-18M393 160h18M289 223v18M371 223v18" stroke="#b7c9df" stroke-width="8" stroke-linecap="round" />
    <circle cx="247" cy="160" r="5" fill="#55d6f5" />
    <circle cx="413" cy="160" r="5" fill="#55d6f5" />
  </g>

  <g aria-label="birthday cake">
    <ellipse cx="473" cy="235" rx="77" ry="12" fill="#07152f" opacity="0.8" />
    <rect x="414" y="225" width="118" height="8" rx="4" fill="#b7c9df" />
    <path d="M428 179h92v48h-92z" fill="#ff8fb1" />
    <path d="M428 179c13 13 24-7 37 5 13 12 24-8 37 4 10 9 14-1 18-9v18h-92Z" fill="#fff2f4" />
    <circle cx="450" cy="203" r="4" fill="#ffcc66" />
    <circle cx="474" cy="214" r="4" fill="#55d6f5" />
    <circle cx="499" cy="201" r="4" fill="#8b8cff" />
    <path d="M473 179v-25" stroke="#fff2b5" stroke-width="6" stroke-linecap="round" />
    <path d="M473 148c-10-12 7-17 0-27 16 10 13 22 5 29" fill="#ffcc66" stroke="#fff2b5" stroke-width="2" />
    <path d="M432 194v30M452 187v40M492 187v40M512 194v30" stroke="#d86f92" stroke-width="3" opacity="0.8" />
  </g>

  <text x="575" y="66" font-family="${FONT_FAMILY}" font-size="29" font-weight="700" letter-spacing="1" fill="#ffffff">HAPPY CAKE DAY!</text>
  <path d="M575 83h280" stroke="url(#accent)" stroke-width="3" stroke-linecap="round" />
  <text x="575" y="119" font-family="${FONT_FAMILY}" font-size="16" letter-spacing="2" fill="#9fb3d0">CELEBRATING</text>
  <text x="575" y="151" font-family="${FONT_FAMILY}" font-size="26" font-weight="700" fill="#ffffff">${safeName}</text>
  <rect x="570" y="178" width="290" height="48" rx="12" fill="#0d2143" stroke="#31547e" stroke-width="2" />
  <circle cx="592" cy="202" r="7" fill="#ffcc66" />
  <text x="608" y="207" font-family="${FONT_FAMILY}" font-size="11" font-weight="700" letter-spacing="0.3" fill="#dcecff">${safeYearLabel}</text>
</svg>`;
}

async function fetchDiscordAvatarDataUri(url: string): Promise<string | undefined> {
  if (
    !url.startsWith('https://cdn.discordapp.com/') &&
    !url.startsWith('https://media.discordapp.net/')
  ) {
    return undefined;
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get('content-type') ?? 'image/png';
    if (!contentType.startsWith('image/')) {
      return undefined;
    }

    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > 2_000_000) {
      return undefined;
    }

    return `data:${contentType};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function truncateDisplayName(displayName: string): string {
  const characters = [...displayName];
  return characters.length > 24 ? `${characters.slice(0, 23).join('')}…` : displayName;
}

function getUserInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .slice(0, 2)
      .map((word) => [...word][0] ?? '')
      .join('')
      .toUpperCase();
  }

  return [...(words[0] ?? 'ST')].slice(0, 2).join('').toUpperCase();
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
