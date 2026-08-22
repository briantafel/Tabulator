/** Severity marker. Shape carries the meaning alongside colour — a circle for
 *  "crappy", a triangle for "dicey" — so the table still reads in greyscale
 *  and for a colourblind viewer. Colour alone would not survive either. */
export default function Dot({ kind, label }) {
  // Always render the slot, even with no severity — an empty box keeps the
  // number aligned with the rows that do carry a marker.
  if (!kind) return <span className="sev sev-none" aria-hidden="true" />;
  return (
    <span
      className={`sev sev-${kind}`}
      role="img"
      title={label}
      aria-label={label}
    />
  );
}
