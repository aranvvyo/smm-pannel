// Pure service search. Matches an exact service ID first, then every
// keyword in the name, description, category or type. No React, no network.
//
// IDs: the provider service id ("#1234", "1234") and the panel id are both
// accepted. An exact ID match always ranks above keyword matches.

export function filterServices(services, query) {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return services;

  const idQuery = raw.replace(/^#/, '');
  const isNumericId = /^\d+$/.test(idQuery);

  const exact = [];
  const keywordHits = [];
  const tokens = raw.split(/\s+/).filter(Boolean);

  for (const s of services) {
    const byId = isNumericId && (
      String(s.provider_service_id ?? '') === idQuery || String(s.id) === idQuery
    );
    if (byId) { exact.push(s); continue; }
    const hay = [s.name, s.description, s.category_name, s.type]
      .map((v) => String(v || '').toLowerCase()).join(' ');
    if (tokens.every((t) => hay.includes(t))) keywordHits.push(s);
  }
  return [...exact, ...keywordHits.filter((s) => !exact.includes(s))];
}
