import { useState, useCallback, useEffect, useRef } from "react";

interface LogEntry {
  timestamp: string;
  context: string;
  type: "ERROR" | "EXCEPTION" | "REJECTION";
  message: string;
  fullStack: string;
}

function parseLogEntries(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  // split on blank lines before each timestamped entry
  const blocks = raw.split(/\n\n(?=\[20)/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const tsMatch = trimmed.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\]\s+(.+?)(?:\n|$)/);
    if (!tsMatch) continue;

    const timestamp = tsMatch[1];
    const header = tsMatch[2];
    const rest = trimmed.substring(tsMatch[0].length).trim();

    let type: LogEntry["type"] = "ERROR";
    let context = "";
    let message = rest.split("\n")[0] ?? "";

    if (header.startsWith("ERROR in")) {
      type = "ERROR";
      context = header.replace("ERROR in ", "").trim();
      message = rest.split("\n")[0] ?? "";
    } else if (header.startsWith("UNCAUGHT EXCEPTION")) {
      type = "EXCEPTION";
      context = "Process";
      message = rest.split("\n")[0] ?? "";
    } else if (header.startsWith("UNHANDLED REJECTION")) {
      type = "REJECTION";
      context = "Promise";
      message = rest.split("\n")[0] ?? "";
    } else if (header.startsWith("EXPRESS ERROR")) {
      type = "ERROR";
      context = "Express Middleware";
      message = rest.split("\n")[0] ?? "";
    } else {
      context = header;
    }

    entries.push({ timestamp, context, type, message, fullStack: rest });
  }
  return entries.reverse(); // newest first
}

const typeColors: Record<LogEntry["type"], { badge: string; row: string; border: string }> = {
  ERROR: {
    badge: "bg-red-500/20 text-red-400 border-red-500/30",
    row: "bg-red-950/10 hover:bg-red-950/20",
    border: "border-red-500/20",
  },
  EXCEPTION: {
    badge: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    row: "bg-orange-950/10 hover:bg-orange-950/20",
    border: "border-orange-500/20",
  },
  REJECTION: {
    badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    row: "bg-yellow-950/10 hover:bg-yellow-950/20",
    border: "border-yellow-500/20",
  },
};

export default function ServerLogsPanel() {
  const [logs, setLogs] = useState<string>("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastFetched, setLastFetched] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/server-errors");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setLogs(text);
      setEntries(parseLogEntries(text));
      setLastFetched(new Date().toLocaleTimeString());
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch logs");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchLogs, 10000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchLogs]);

  const clearLogs = async () => {
    if (!window.confirm("Clear all server error logs? This cannot be undone.")) return;
    setClearing(true);
    try {
      const res = await fetch("/api/clear-server-errors", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogs("");
      setEntries([]);
      setLastFetched(new Date().toLocaleTimeString());
    } catch (err: any) {
      setError(err.message ?? "Failed to clear logs");
    } finally {
      setClearing(false);
    }
  };

  const filtered = entries.filter((e) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.context.toLowerCase().includes(q) ||
      e.message.toLowerCase().includes(q) ||
      e.fullStack.toLowerCase().includes(q)
    );
  });

  const errorCount = entries.filter((e) => e.type === "ERROR").length;
  const exceptionCount = entries.filter((e) => e.type === "EXCEPTION").length;
  const rejectionCount = entries.filter((e) => e.type === "REJECTION").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-red-400">🔴 Server Error Logs</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live view of all server-side errors written to{" "}
            <code className="text-white bg-white/10 px-1 rounded">error_stack.txt</code>
            {lastFetched && (
              <span className="ml-2 text-muted-foreground">· Last fetched {lastFetched}</span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {/* Summary badges */}
          {errorCount > 0 && (
            <span className="text-xs px-2.5 py-1 rounded border bg-red-500/20 text-red-400 border-red-500/30 font-bold">
              {errorCount} Error{errorCount !== 1 ? "s" : ""}
            </span>
          )}
          {exceptionCount > 0 && (
            <span className="text-xs px-2.5 py-1 rounded border bg-orange-500/20 text-orange-400 border-orange-500/30 font-bold">
              {exceptionCount} Exception{exceptionCount !== 1 ? "s" : ""}
            </span>
          )}
          {rejectionCount > 0 && (
            <span className="text-xs px-2.5 py-1 rounded border bg-yellow-500/20 text-yellow-400 border-yellow-500/30 font-bold">
              {rejectionCount} Rejection{rejectionCount !== 1 ? "s" : ""}
            </span>
          )}
          {entries.length === 0 && !isLoading && (
            <span className="text-xs px-2.5 py-1 rounded border bg-green-500/20 text-green-400 border-green-500/30 font-bold">
              ✅ No Errors
            </span>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search errors, routes, stack traces..."
          className="flex-1 min-w-48 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-red-400"
        />
        <button
          onClick={fetchLogs}
          disabled={isLoading}
          className="px-4 py-2.5 bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded-lg text-sm font-semibold transition-all"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Loading…
            </span>
          ) : (
            "🔄 Refresh"
          )}
        </button>
        <button
          onClick={() => setAutoRefresh((v) => !v)}
          className={`px-4 py-2.5 rounded-lg text-sm font-semibold transition-all border ${
            autoRefresh
              ? "bg-green-500/20 text-green-400 border-green-500/30"
              : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"
          }`}
        >
          {autoRefresh ? "⏸ Auto-refresh ON" : "▶ Auto-refresh"}
        </button>
        <button
          onClick={() => {
            const blob = new Blob([logs], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `error_log_${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
          }}
          className="px-4 py-2.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 rounded-lg text-sm font-semibold transition-all"
        >
          ⬇ Download
        </button>
        <button
          onClick={clearLogs}
          disabled={clearing || entries.length === 0}
          className="px-4 py-2.5 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-40 border border-red-500/20 text-red-400 rounded-lg text-sm font-semibold transition-all"
        >
          {clearing ? "Clearing…" : "🗑 Clear Logs"}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-950/20 px-5 py-4 text-sm text-red-400">
          ⚠ {error}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && entries.length === 0 && (
        <div className="w-full p-16 flex flex-col items-center justify-center bg-white/5 rounded-xl border border-white/10 text-center">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-semibold text-green-400">No server errors logged</p>
          <p className="text-sm text-muted-foreground mt-2">
            All API routes are running cleanly. Errors will appear here automatically.
          </p>
        </div>
      )}

      {/* Log entries */}
      {filtered.length > 0 && (
        <div className="space-y-3">
          {search && (
            <p className="text-xs text-muted-foreground">
              Showing {filtered.length} of {entries.length} entries matching "{search}"
            </p>
          )}
          {filtered.map((entry, idx) => {
            const colors = typeColors[entry.type];
            const isExpanded = expandedIdx === idx;
            return (
              <div
                key={idx}
                className={`rounded-xl border ${colors.border} ${colors.row} overflow-hidden transition-all`}
              >
                {/* Entry header — click to expand */}
                <button
                  className="w-full text-left px-5 py-4 flex flex-wrap items-start gap-3"
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                >
                  <span
                    className={`shrink-0 inline-block px-2 py-0.5 rounded text-xs font-bold border ${colors.badge}`}
                  >
                    {entry.type}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground font-mono mt-0.5">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                  <span className="shrink-0 text-xs px-2 py-0.5 bg-white/10 text-white rounded font-mono">
                    {entry.context}
                  </span>
                  <span className="flex-1 text-sm text-white/90 font-medium text-left truncate">
                    {entry.message}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {isExpanded ? "▲ collapse" : "▼ expand"}
                  </span>
                </button>

                {/* Full stack trace */}
                {isExpanded && (
                  <div className="border-t border-white/10 px-5 py-4">
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">
                      Full Stack Trace
                    </p>
                    <pre className="text-xs text-white/80 font-mono whitespace-pre-wrap break-words leading-relaxed bg-black/30 rounded-lg p-4 overflow-x-auto">
                      {entry.fullStack || "(no stack trace)"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Raw log fallback (when parsing produced 0 parsed entries but raw text exists) */}
      {entries.length === 0 && logs && logs.trim() !== "No errors logged yet." && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-5">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
            Raw Log Output
          </p>
          <pre className="text-xs text-white/80 font-mono whitespace-pre-wrap break-words leading-relaxed bg-black/30 rounded-lg p-4 overflow-x-auto max-h-[60vh]">
            {logs}
          </pre>
        </div>
      )}
    </div>
  );
}
