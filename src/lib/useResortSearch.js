import { useState } from "react";

/** Search state for a screen that has a resort search: open or closed, and
 *  the query. Kept by the screen rather than the search itself, so a sheet
 *  opened from the results comes back to the same results. */
export function useResortSearch() {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  return {
    searching, query, setQuery,
    open: () => setSearching(true),
    close: () => { setSearching(false); setQuery(""); },
  };
}
