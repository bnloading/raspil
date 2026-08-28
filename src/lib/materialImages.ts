import akUrl from "../images/Белый.jpeg";
import bunrattiUrl from "../images/бнуратти.jpeg";
import votanUrl from "../images/дуб вотан.jpeg";
import sonomaUrl from "../images/дуб санома.jpeg";
import kanyonUrl from "../images/каньон.jpg";
import svetloSeryiUrl from "../images/светло серый.jpg";
import chesterUrl from "../images/Честер.jpg";

/**
 * Photographs of the sheet finishes, bundled with the app.
 *
 * These are the shop's own catalogue photos: a handful of files that change about as often as the
 * range does, so importing them lets Vite hash and cache them and keeps the catalogue working
 * offline. A `Material.imageUrl` set by an Admin always wins, so a photo can still be replaced
 * from the UI without a deploy.
 *
 * Resolution goes by document id first, then article code, then a colour/name alias — ids are
 * exact, while a shop adding "ЛДСП Дуб Вотан 18мм" later should still get the right picture.
 */

/** Exact, and the only key that cannot collide. */
const BY_ID: Record<string, string> = {
  "ldsp-ak": akUrl,
  "ldsp-bunratti": bunrattiUrl,
  "ldsp-dub-votan": votanUrl,
  "ldsp-sonoma": sonomaUrl,
  "ldsp-svetlo-seryi": svetloSeryiUrl,
  "ldsp-chesterfield": chesterUrl,
};

const BY_ARTICLE: Record<string, string> = {
  "ak001": akUrl,
  "db015": bunrattiUrl,
  "dv014": votanUrl,
  "ds016": sonomaUrl,
  "ss002": svetloSeryiUrl,
  "ch017": chesterUrl,
};

/**
 * Colour/name aliases. Both spellings of the awkward ones are listed on purpose: the photo files
 * say "бнуратти" and "санома" while the catalogue says "Бунратти" and "Сонома", and "Честер" is
 * the everyday short form of "Честерфилд".
 */
const BY_ALIAS: Record<string, string> = {
  ак: akUrl,
  белый: akUrl,
  бунратти: bunrattiUrl,
  бнуратти: bunrattiUrl,
  дуббунратти: bunrattiUrl,
  вотан: votanUrl,
  дубвотан: votanUrl,
  сонома: sonomaUrl,
  санома: sonomaUrl,
  дубсонома: sonomaUrl,
  каньон: kanyonUrl,
  светлосерый: svetloSeryiUrl,
  серый: svetloSeryiUrl,
  честер: chesterUrl,
  честерфилд: chesterUrl,
};

/** Lowercase, drop everything that is not a letter or digit, so spacing and case stop mattering. */
function key(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
}

export interface ImageSubject {
  id?: string;
  article?: string;
  name?: string;
  /** `Material.color` or `PvcType.colorName` — both name a finish. */
  color?: string;
  colorName?: string;
  /** An Admin-supplied override; wins over anything bundled. */
  imageUrl?: string;
}

/**
 * The picture for a sheet or edge-banding colour, or null when there is none.
 *
 * Null is a real answer — "Сырттан келетін лист" is the customer's own material and has no
 * catalogue photo by definition, so callers render their placeholder swatch rather than a broken
 * image.
 */
export function materialImage(subject: ImageSubject | undefined): string | null {
  if (!subject) return null;
  const override = subject.imageUrl?.trim();
  if (override) return override;

  if (subject.id && BY_ID[subject.id]) return BY_ID[subject.id];

  const article = key(subject.article);
  if (article && BY_ARTICLE[article]) return BY_ARTICLE[article];

  // Longest alias first, so "дуб вотан" is not shadowed by a shorter partial.
  const haystack = `${key(subject.color ?? subject.colorName)} ${key(subject.name)}`;
  const aliases = Object.keys(BY_ALIAS).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (haystack.includes(alias)) return BY_ALIAS[alias];
  }
  return null;
}
