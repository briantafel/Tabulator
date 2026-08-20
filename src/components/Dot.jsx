export default function Dot({ kind, label }) {
  return <span className={`dot dot-${kind}`} title={label} aria-label={label} />;
}
