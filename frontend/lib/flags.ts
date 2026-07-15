/** Team name -> flagcdn code, for the 48 nations in the 2026 finals.
 *
 *  Keys are the TxLINE feed's team strings verbatim ("Congo DR", "USA",
 *  "Curacao"), so this map only holds while the feed spells them that way —
 *  a rename shows up as a missing flag, not a broken image.
 *
 *  UK home nations use flagcdn's subdivision codes (gb-eng, gb-sct), not ISO
 *  3166-1, which has no code for them.
 */
const TEAM_FLAG_CODE: Record<string, string> = {
  Algeria: "dz",
  Argentina: "ar",
  Australia: "au",
  Austria: "at",
  Belgium: "be",
  "Bosnia & Herzegovina": "ba",
  Brazil: "br",
  Canada: "ca",
  "Cape Verde": "cv",
  Colombia: "co",
  "Congo DR": "cd",
  Croatia: "hr",
  Curacao: "cw",
  "Czech Republic": "cz",
  Ecuador: "ec",
  Egypt: "eg",
  England: "gb-eng",
  France: "fr",
  Germany: "de",
  Ghana: "gh",
  Haiti: "ht",
  Iran: "ir",
  Iraq: "iq",
  "Ivory Coast": "ci",
  Japan: "jp",
  Jordan: "jo",
  Mexico: "mx",
  Morocco: "ma",
  Netherlands: "nl",
  "New Zealand": "nz",
  Norway: "no",
  Panama: "pa",
  Paraguay: "py",
  Portugal: "pt",
  Qatar: "qa",
  "Saudi Arabia": "sa",
  Scotland: "gb-sct",
  Senegal: "sn",
  "South Africa": "za",
  "South Korea": "kr",
  Spain: "es",
  Sweden: "se",
  Switzerland: "ch",
  Tunisia: "tn",
  Turkey: "tr",
  USA: "us",
  Uruguay: "uy",
  Uzbekistan: "uz",
};

/** null for unresolved bracket slots ("Winner SF1") — they have no nation yet. */
export function flagUrl(team: string, width: 40 | 80 | 160 | 320 = 80): string | null {
  const code = TEAM_FLAG_CODE[team];
  return code ? `https://flagcdn.com/w${width}/${code}.png` : null;
}
