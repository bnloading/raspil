import { materialImage, type ImageSubject } from "../lib/materialImages";

/**
 * The small finish photo shown beside a sheet's name.
 *
 * Renders a neutral placeholder rather than a broken image when a material has no picture —
 * "Сырттан келетін лист" is the customer's own board and legitimately has none.
 */
export function MaterialThumb({
  material,
  size = "sm",
}: {
  material: ImageSubject | undefined;
  size?: "sm" | "md";
}) {
  const src = materialImage(material);
  const label = material?.name ?? material?.color ?? material?.colorName ?? "";

  if (!src) return <span className={`mthumb is-${size} is-empty`} aria-hidden="true" />;
  return (
    <img
      className={`mthumb is-${size}`}
      src={src}
      alt={label}
      loading="lazy"
      decoding="async"
      // A missing or renamed file must not leave a broken-image icon in a table.
      onError={(e) => {
        e.currentTarget.classList.add("is-empty");
        e.currentTarget.removeAttribute("src");
      }}
    />
  );
}
