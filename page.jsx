import { useState, useRef, useCallback, useEffect } from "react";

const BACKEND_URL = "http://localhost:3001";

// Platform config
const PLATFORMS = {
  resy: { name: "Resy", icon: "🟢", color: "#00c853", bg: "#e8f5e9" },
  opentable: { name: "OpenTable", icon: "🔴", color: "#da3743", bg: "#fce4ec" },
  yelp: { name: "Yelp", icon: "🟡", color: "#ff1a1a", bg: "#fff3e0" },
};

function getNextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().split("T")[0];
}

export default function TableFinder() {
  const [location, setLocation] = useState("Atlanta, GA");
  const [cuisine, setCuisine] = useState("");
  const [date, setDate] = useState(getNextFriday());
  const [time, setTime] = useState("19:00");
  const [partySize, setPartySize] = useState(2);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [platformStatus, setPlatformStatus] = useState({});
  const [error, setError] = useState(null);
  const [totalLatency, setTotalLatency] = useState(null);
  const [useStreaming, setUseStreaming] = useState(true);
  const eventSourceRef = useRef(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const searchStreaming = useCallback(() => {
    cleanup();
    setResults([]);
    setError(null);
    setSearching(true);
    setTotalLatency(null);
    setPlatformStatus({
      resy: { status: "searching" },
      opentable: { status: "searching" },
      yelp: { status: "searching" },
    });

    const startTime = Date.now();
    const params = new URLSearchParams({
      location, date, time, partySize: String(partySize),
      ...(cuisine && { cuisine }),
    });

    const es = new EventSource(`${BACKEND_URL}/api/search/stream?${params}`);
    eventSourceRef.current = es;

    es.addEventListener("results", (e) => {
      try {
        const data = JSON.parse(e.data);
        const { source, results: newResults, latency, error: srcError } = data;
        setPlatformStatus((prev) => ({
          ...prev,
          [source]: {
            status: srcError ? "error" : "done",
            count: newResults.length,
            latency,
            error: srcError,
          },
        }));
        if (newResults.length > 0) {
          setResults((prev) => deduplicateAndSort([...prev, ...newResults]));
        }
      } catch (err) {
        console.error("Parse error:", err);
      }
    });

    es.addEventListener("complete", () => {
      setSearching(false);
      setTotalLatency(Date.now() - startTime);
      es.close();
    });

    es.addEventListener("error", () => {
      setError("Connection lost — retrying or try the batch endpoint.");
      setSearching(false);
      setTotalLatency(Date.now() - startTime);
      es.close();
    });
  }, [location, cuisine, date, time, partySize, cleanup]);

  const searchBatch = useCallback(async () => {
    setResults([]);
    setError(null);
    setSearching(true);
    setTotalLatency(null);
    setPlatformStatus({
      resy: { status: "searching" },
      opentable: { status: "searching" },
      yelp: { status: "searching" },
    });

    const params = new URLSearchParams({
      location, date, time, partySize: String(partySize),
      ...(cuisine && { cuisine }),
    });

    try {
      const res = await fetch(`${BACKEND_URL}/api/search?${params}`);
      const data = await res.json();

      if (data.error) {
        setError(data.error);
      } else {
        setResults(data.results || []);
        setPlatformStatus(
          Object.fromEntries(
            Object.entries(data.meta?.platforms || {}).map(([k, v]) => [
              k,
              { status: v.error ? "error" : "done", ...v },
            ])
          )
        );
        setTotalLatency(data.meta?.latency || data.meta?.requestLatency);
      }
    } catch (err) {
      setError(`Backend unreachable: ${err.message}. Is the server running on port 3001?`);
    } finally {
      setSearching(false);
    }
  }, [location, cuisine, date, time, partySize]);

  const handleSearch = () => (useStreaming ? searchStreaming() : searchBatch());

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.logo}>
            <span style={styles.logoIcon}>◉</span> TableFinder
            <span style={styles.badge}>POC</span>
          </h1>
          <p style={styles.subtitle}>
            Real availability across Resy, OpenTable &amp; Yelp
          </p>
        </div>
      </header>

      <main style={styles.main}>
        {/* Search Form */}
        <div style={styles.searchCard}>
          <div style={styles.searchGrid}>
            <div style={styles.field}>
              <label style={styles.label}>Location</label>
              <input style={styles.input} value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City or neighborhood" />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Cuisine</label>
              <input style={styles.input} value={cuisine}
                onChange={(e) => setCuisine(e.target.value)}
                placeholder="Italian, Sushi, etc." />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Date</label>
              <input style={styles.input} type="date" value={date}
                onChange={(e) => setDate(e.target.value)} />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Time</label>
              <select style={styles.input} value={time}
                onChange={(e) => setTime(e.target.value)}>
                {["17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30","21:00","21:30"]
                  .map(t => {
                    const [h, m] = t.split(":");
                    const hr = parseInt(h);
                    const disp = `${hr > 12 ? hr - 12 : hr}:${m} ${hr >= 12 ? "PM" : "AM"}`;
                    return <option key={t} value={t}>{disp}</option>;
                  })}
              </select>
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Party</label>
              <select style={styles.input} value={partySize}
                onChange={(e) => setPartySize(parseInt(e.target.value))}>
                {[1,2,3,4,5,6,7,8].map(n => (
                  <option key={n} value={n}>{n} {n === 1 ? "guest" : "guests"}</option>
                ))}
              </select>
            </div>
            <div style={{ ...styles.field, display: "flex", alignItems: "flex-end" }}>
              <button style={styles.searchBtn} onClick={handleSearch} disabled={searching}>
                {searching ? "Searching..." : "Find Tables"}
              </button>
            </div>
          </div>

          <div style={styles.modeRow}>
            <label style={styles.modeLabel}>
              <input type="checkbox" checked={useStreaming}
                onChange={(e) => setUseStreaming(e.target.checked)} />
              {" "}Stream results (show each platform as it responds)
            </label>
          </div>
        </div>

        {/* Platform Status */}
        {Object.keys(platformStatus).length > 0 && (
          <div style={styles.statusRow}>
            {Object.entries(platformStatus).map(([key, status]) => (
              <PlatformBadge key={key} platform={key} status={status} />
            ))}
            {totalLatency && (
              <span style={styles.latencyBadge}>
                Total: {(totalLatency / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        )}

        {/* Error */}
        {error && <div style={styles.errorBox}>{error}</div>}

        {/* Results */}
        {results.length > 0 && (
          <div style={styles.resultsSection}>
            <h2 style={styles.resultsTitle}>
              {results.length} restaurant{results.length !== 1 ? "s" : ""} with
              available tables
            </h2>
            <div style={styles.resultsGrid}>
              {results.map((r, i) => (
                <RestaurantCard key={`${r.name}-${r.source}-${i}`} restaurant={r} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!searching && Object.keys(platformStatus).length > 0 && results.length === 0 && !error && (
          <div style={styles.emptyState}>
            <p style={{ fontSize: 18 }}>No available tables found</p>
            <p style={{ color: "#888" }}>
              Try a different date, time, or cuisine — or expand your location
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

function PlatformBadge({ platform, status }) {
  const p = PLATFORMS[platform] || { name: platform, icon: "⚪", color: "#999" };
  const statusIcon = status.status === "searching" ? "⏳"
    : status.status === "done" ? "✅"
    : "⚠️";
  const latency = status.latency ? `${(status.latency / 1000).toFixed(1)}s` : "";

  return (
    <div style={{
      ...styles.platformBadge,
      borderColor: status.status === "error" ? "#f44336" : p.color,
      opacity: status.status === "searching" ? 0.7 : 1,
    }}>
      <span>{p.icon} {p.name}</span>
      <span style={{ marginLeft: 6 }}>{statusIcon}</span>
      {status.count != null && (
        <span style={styles.badgeCount}>{status.count}</span>
      )}
      {latency && <span style={styles.badgeLatency}>{latency}</span>}
      {status.error && (
        <span style={{ fontSize: 10, color: "#f44336", marginLeft: 4 }}
          title={status.error}>⚠</span>
      )}
    </div>
  );
}

function RestaurantCard({ restaurant: r }) {
  const p = PLATFORMS[r.source] || PLATFORMS.resy;

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div>
          <h3 style={styles.cardName}>{r.name}</h3>
          <div style={styles.cardMeta}>
            {r.cuisine && <span>{r.cuisine}</span>}
            {r.priceRange && <span> · {r.priceRange}</span>}
            {r.rating && <span> · ⭐ {r.rating}</span>}
            {r.neighborhood && <span> · {r.neighborhood}</span>}
          </div>
        </div>
        <div style={{
          ...styles.sourcePill,
          background: p.bg,
          color: p.color,
        }}>
          {p.icon} {p.name}
        </div>
      </div>

      <div style={styles.timeSlots}>
        {(r.timeSlots || []).slice(0, 8).map((slot, i) => (
          <a key={i} href={r.bookingUrl} target="_blank" rel="noopener noreferrer"
            style={styles.timeSlot}
            onMouseEnter={(e) => { e.target.style.background = "#1a1a2e"; e.target.style.color = "#fff"; }}
            onMouseLeave={(e) => { e.target.style.background = "#f5f5f7"; e.target.style.color = "#1a1a2e"; }}>
            {slot}
          </a>
        ))}
        {(r.timeSlots || []).length > 8 && (
          <span style={styles.moreSlots}>+{r.timeSlots.length - 8} more</span>
        )}
      </div>

      {r.address && <p style={styles.cardAddress}>{r.address}</p>}

      {r.confidence === "confirmed" && (
        <div style={styles.confirmedBadge}>✓ Confirmed availability</div>
      )}
    </div>
  );
}

function deduplicateAndSort(results) {
  const seen = new Map();
  for (const r of results) {
    const key = r.name.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
    if (!seen.has(key) || (r.timeSlots?.length || 0) > (seen.get(key).timeSlots?.length || 0)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.confidence === "confirmed" && b.confidence !== "confirmed") return -1;
    if (b.confidence === "confirmed" && a.confidence !== "confirmed") return 1;
    return (b.timeSlots?.length || 0) - (a.timeSlots?.length || 0);
  });
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#fafafa",
    fontFamily: "'DM Sans', 'SF Pro Display', -apple-system, sans-serif",
    color: "#1a1a2e",
  },
  header: {
    background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
    padding: "32px 24px 28px",
    borderBottom: "3px solid #e94560",
  },
  headerInner: { maxWidth: 900, margin: "0 auto" },
  logo: {
    margin: 0, fontSize: 28, fontWeight: 700, color: "#fff",
    display: "flex", alignItems: "center", gap: 8,
  },
  logoIcon: { color: "#e94560", fontSize: 24 },
  badge: {
    fontSize: 10, background: "#e94560", color: "#fff",
    padding: "2px 8px", borderRadius: 4, marginLeft: 8,
    fontWeight: 600, letterSpacing: 1, textTransform: "uppercase",
  },
  subtitle: { margin: "6px 0 0", color: "rgba(255,255,255,0.6)", fontSize: 14 },
  main: { maxWidth: 900, margin: "0 auto", padding: "24px 16px" },
  searchCard: {
    background: "#fff", borderRadius: 12, padding: 24,
    boxShadow: "0 2px 12px rgba(0,0,0,0.06)", marginBottom: 20,
  },
  searchGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 16,
  },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 12, fontWeight: 600, color: "#666", textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    padding: "10px 12px", border: "1.5px solid #e0e0e0", borderRadius: 8,
    fontSize: 14, background: "#fafafa", outline: "none", fontFamily: "inherit",
  },
  searchBtn: {
    padding: "10px 28px", background: "#1a1a2e", color: "#fff",
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: "pointer", width: "100%", fontFamily: "inherit",
  },
  modeRow: { marginTop: 12, paddingTop: 12, borderTop: "1px solid #f0f0f0" },
  modeLabel: { fontSize: 13, color: "#888", cursor: "pointer" },
  statusRow: {
    display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20,
    alignItems: "center",
  },
  platformBadge: {
    display: "flex", alignItems: "center", gap: 4,
    padding: "6px 14px", borderRadius: 20,
    border: "1.5px solid", background: "#fff",
    fontSize: 13, fontWeight: 500,
  },
  badgeCount: {
    background: "#f0f0f0", borderRadius: 10,
    padding: "1px 8px", fontSize: 11, fontWeight: 700, marginLeft: 4,
  },
  badgeLatency: { fontSize: 11, color: "#999", marginLeft: 2 },
  latencyBadge: {
    fontSize: 13, color: "#666", fontWeight: 500,
    padding: "6px 14px", background: "#f5f5f7", borderRadius: 20,
  },
  errorBox: {
    background: "#fff3f3", border: "1px solid #ffcdd2", borderRadius: 8,
    padding: 16, color: "#c62828", marginBottom: 20, fontSize: 14,
  },
  resultsSection: { marginTop: 8 },
  resultsTitle: { fontSize: 18, fontWeight: 600, marginBottom: 16, color: "#333" },
  resultsGrid: { display: "flex", flexDirection: "column", gap: 14 },
  card: {
    background: "#fff", borderRadius: 12, padding: 20,
    boxShadow: "0 1px 8px rgba(0,0,0,0.05)",
    border: "1px solid #f0f0f0",
    transition: "box-shadow 0.2s",
  },
  cardHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    marginBottom: 14, gap: 12,
  },
  cardName: { margin: 0, fontSize: 17, fontWeight: 600 },
  cardMeta: { fontSize: 13, color: "#777", marginTop: 4 },
  sourcePill: {
    fontSize: 11, fontWeight: 600, padding: "4px 10px",
    borderRadius: 12, whiteSpace: "nowrap", flexShrink: 0,
  },
  timeSlots: { display: "flex", flexWrap: "wrap", gap: 8 },
  timeSlot: {
    padding: "8px 16px", background: "#f5f5f7", borderRadius: 8,
    fontSize: 13, fontWeight: 600, color: "#1a1a2e",
    textDecoration: "none", cursor: "pointer",
    transition: "all 0.15s", border: "1px solid #e8e8ea",
  },
  moreSlots: { fontSize: 12, color: "#999", alignSelf: "center", marginLeft: 4 },
  cardAddress: { margin: "10px 0 0", fontSize: 12, color: "#999" },
  confirmedBadge: {
    marginTop: 10, fontSize: 11, color: "#2e7d32",
    fontWeight: 600, letterSpacing: 0.3,
  },
  emptyState: { textAlign: "center", padding: 48, color: "#555" },
};
