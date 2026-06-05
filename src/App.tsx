import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileJson,
  FolderOpen,
  ListFilter,
  Music2,
  PauseCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
  AudioWaveform
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

type AnalysisResult = {
  bpm: number | null;
  bpmConfidence: number;
  bpmCandidates: number[];
  key: string | null;
  scale: string | null;
  keyConfidence: number;
  keyCandidates: string[];
  pitchHz: number | null;
  pitchNote: string | null;
  pitchConfidence: number;
  sampleType: string;
  engine: string;
  durationSeconds: number | null;
  sampleRate: number | null;
  channels: number | null;
  waveform: number[];
  warnings: string[];
};

type SampleRecord = {
  id: string;
  path: string;
  fileName: string;
  extension: string;
  folder: string;
  fileSize: number;
  lastModified: number | null;
  status: "queued" | "analyzing" | "done" | "error";
  analysis?: AnalysisResult;
  error?: string;
  verified?: boolean;
  userKey?: string;
  userScale?: string;
  userBpm?: string;
  userPitch?: string;
};

type FilterKey = "all" | "review" | "loops" | "oneshots" | "tonal" | "unknown" | "verified";
type ExportFormat = "csv" | "json";

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "review", label: "Needs review" },
  { key: "loops", label: "Loops" },
  { key: "oneshots", label: "One-shots" },
  { key: "tonal", label: "Tonal" },
  { key: "unknown", label: "Unknown" },
  { key: "verified", label: "Verified" }
];

const confidenceLabel = (value?: number) => {
  if (!value || value < 0.15) return "Unknown";
  if (value >= 0.68) return "High";
  if (value >= 0.35) return "Medium";
  return "Low";
};

const formatDuration = (seconds?: number | null) => {
  if (!seconds || !Number.isFinite(seconds)) return "-";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${rest}`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const formatPercent = (value?: number) => `${Math.round((value ?? 0) * 100)}%`;

function App() {
  const [samples, setSamples] = useState<SampleRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [notice, setNotice] = useState("Open a folder to begin.");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const cancelRequested = useRef(false);

  const selected = useMemo(
    () => samples.find((sample) => sample.id === selectedId) ?? samples[0],
    [samples, selectedId]
  );

  const stats = useMemo(() => {
    const analyzed = samples.filter((sample) => sample.status === "done").length;
    const review = samples.filter((sample) => needsReview(sample)).length;
    const verified = samples.filter((sample) => sample.verified).length;
    return { analyzed, review, verified };
  }, [samples]);

  const filteredSamples = useMemo(() => {
    const search = query.trim().toLowerCase();

    return samples.filter((sample) => {
      const analysis = sample.analysis;
      const type = analysis?.sampleType.toLowerCase() ?? "";
      const matchesSearch =
        !search ||
        sample.fileName.toLowerCase().includes(search) ||
        sample.folder.toLowerCase().includes(search) ||
        (analysis?.key ?? "").toLowerCase().includes(search) ||
        (analysis?.pitchNote ?? "").toLowerCase().includes(search);

      if (!matchesSearch) return false;

      switch (activeFilter) {
        case "review":
          return needsReview(sample);
        case "loops":
          return type.includes("loop");
        case "oneshots":
          return type.includes("one-shot");
        case "tonal":
          return type.includes("tonal") || Boolean(analysis?.key || analysis?.pitchNote);
        case "unknown":
          return type.includes("unknown") || sample.status === "error";
        case "verified":
          return Boolean(sample.verified);
        default:
          return true;
      }
    });
  }, [activeFilter, query, samples]);

  const openFolder = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "Open sample folder"
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;

    setNotice("Scanning folder...");
    setFolderPath(selectedPath);
    cancelRequested.current = true;
    setIsAnalyzing(false);

    try {
      const scanned = await invoke<SampleRecord[]>("scan_folder", { path: selectedPath });
      setSamples(scanned);
      setSelectedId(scanned[0]?.id ?? null);
      setNotice(scanned.length ? `Found ${scanned.length} audio files.` : "No supported audio files found.");
    } catch (error) {
      setNotice(String(error));
    }
  };

  const analyzeAll = async () => {
    if (!samples.length || isAnalyzing) return;
    cancelRequested.current = false;
    setIsAnalyzing(true);
    setNotice("Analyzing samples...");

    for (const sample of samples) {
      if (cancelRequested.current) break;
      if (sample.status === "done" && sample.analysis) continue;

      setSamples((current) =>
        current.map((item) =>
          item.id === sample.id ? { ...item, status: "analyzing", error: undefined } : item
        )
      );

      try {
        const analysis = await invoke<AnalysisResult>("analyze_sample", { path: sample.path });
        setSamples((current) =>
          current.map((item) =>
            item.id === sample.id ? { ...item, status: "done", analysis } : item
          )
        );
      } catch (error) {
        setSamples((current) =>
          current.map((item) =>
            item.id === sample.id ? { ...item, status: "error", error: String(error) } : item
          )
        );
      }
    }

    setIsAnalyzing(false);
    setNotice(cancelRequested.current ? "Analysis paused." : "Analysis complete.");
  };

  const pauseAnalysis = () => {
    cancelRequested.current = true;
    setNotice("Finishing current file, then pausing.");
  };

  const reanalyzeSelected = async () => {
    if (!selected) return;
    setSamples((current) =>
      current.map((item) =>
        item.id === selected.id ? { ...item, status: "analyzing", error: undefined } : item
      )
    );

    try {
      const analysis = await invoke<AnalysisResult>("analyze_sample", { path: selected.path });
      setSamples((current) =>
        current.map((item) =>
          item.id === selected.id ? { ...item, status: "done", analysis, verified: false } : item
        )
      );
      setNotice(`Re-analyzed ${selected.fileName}.`);
    } catch (error) {
      setSamples((current) =>
        current.map((item) =>
          item.id === selected.id ? { ...item, status: "error", error: String(error) } : item
        )
      );
    }
  };

  const exportSamples = async (format: ExportFormat) => {
    if (!samples.length) return;

    const target = await save({
      title: `Export ${format.toUpperCase()}`,
      defaultPath: `sample-key-studio-export.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    });

    if (!target) return;

    await invoke("export_results", {
      path: target,
      format,
      samples: samples.map((sample) => ({
        path: sample.path,
        fileName: sample.fileName,
        extension: sample.extension,
        folder: sample.folder,
        fileSize: sample.fileSize,
        verified: Boolean(sample.verified),
        analysis: mergeUserValues(sample)
      }))
    });

    setNotice(`Exported ${samples.length} samples.`);
  };

  const updateSelected = (patch: Partial<SampleRecord>) => {
    if (!selected) return;
    setSamples((current) =>
      current.map((sample) => (sample.id === selected.id ? { ...sample, ...patch } : sample))
    );
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <AudioWaveform size={22} />
          </div>
          <div>
            <h1>Sample Key Studio</h1>
            <p>{folderPath || notice}</p>
          </div>
        </div>

        <div className="toolbar">
          <button className="primary" onClick={openFolder} title="Open folder">
            <FolderOpen size={17} />
            <span>Open</span>
          </button>
          <button onClick={analyzeAll} disabled={!samples.length || isAnalyzing} title="Analyze folder">
            <Sparkles size={17} />
            <span>Analyze</span>
          </button>
          <button onClick={pauseAnalysis} disabled={!isAnalyzing} title="Pause analysis">
            <PauseCircle size={17} />
            <span>Pause</span>
          </button>
          <button onClick={() => exportSamples("csv")} disabled={!samples.length} title="Export CSV">
            <Download size={17} />
            <span>CSV</span>
          </button>
          <button onClick={() => exportSamples("json")} disabled={!samples.length} title="Export JSON">
            <FileJson size={17} />
            <span>JSON</span>
          </button>
        </div>
      </header>

      <section
        className={`content-grid ${!isSidebarOpen ? "sidebar-collapsed" : ""} ${
          !isInspectorOpen ? "inspector-collapsed" : ""
        }`}
      >
        <aside className="rail left-rail">
          <button
            onClick={() => setIsSidebarOpen((value) => !value)}
            title={isSidebarOpen ? "Hide filters" : "Show filters"}
          >
            {isSidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </aside>

        <aside className="sidebar">
          <div className="stat-grid">
            <Metric label="Files" value={samples.length.toString()} />
            <Metric label="Done" value={stats.analyzed.toString()} />
            <Metric label="Review" value={stats.review.toString()} />
            <Metric label="Verified" value={stats.verified.toString()} />
          </div>

          <div className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />
          </div>

          <nav className="filters" aria-label="Sample filters">
            <div className="nav-heading">
              <ListFilter size={15} />
              <span>Filters</span>
            </div>
            {filters.map((filter) => (
              <button
                key={filter.key}
                className={filter.key === activeFilter ? "active" : ""}
                onClick={() => setActiveFilter(filter.key)}
              >
                {filter.label}
                <span>{countForFilter(samples, filter.key)}</span>
              </button>
            ))}
          </nav>

          <div className="status-strip">
            <Activity size={15} />
            <span>{notice}</span>
          </div>
        </aside>

        <section className="sample-area">
          <div className="table-header">
            <div>
              <h2>Library</h2>
              <p>{filteredSamples.length} visible samples</p>
            </div>
            <div className="table-tools">
              <Table2 size={16} />
              <span>{isAnalyzing ? "Analyzing" : "Ready"}</span>
            </div>
          </div>

          <div className="sample-table" role="table">
            <div className="sample-row heading" role="row">
              <span>File</span>
              <span>Type</span>
              <span>Key</span>
              <span>Pitch</span>
              <span>BPM</span>
              <span>Confidence</span>
            </div>
            <div className="table-scroll">
              {filteredSamples.map((sample) => (
                <button
                  key={sample.id}
                  className={`sample-row ${selected?.id === sample.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(sample.id)}
                  role="row"
                >
                  <span className="file-cell">
                    <strong>{sample.fileName}</strong>
                    <small>{sample.folder}</small>
                  </span>
                  <span>{sample.analysis?.sampleType ?? sample.status}</span>
                  <span>{displayKey(sample)}</span>
                  <span>{sample.userPitch || sample.analysis?.pitchNote || "-"}</span>
                  <span>{sample.userBpm || sample.analysis?.bpm?.toFixed(1) || "-"}</span>
                  <span>
                    <ConfidenceBadge sample={sample} />
                  </span>
                </button>
              ))}

              {!filteredSamples.length && (
                <div className="empty-state">
                  <Music2 size={42} />
                  <h3>No samples visible</h3>
                  <p>{samples.length ? "Adjust filters or search." : "Open a folder to load audio."}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <Inspector
          sample={selected}
          isOpen={isInspectorOpen}
          onToggle={() => setIsInspectorOpen((value) => !value)}
          onChange={updateSelected}
          onReanalyze={reanalyzeSelected}
        />
      </section>
    </main>
  );
}

function Inspector({
  sample,
  isOpen,
  onToggle,
  onChange,
  onReanalyze
}: {
  sample?: SampleRecord;
  isOpen: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<SampleRecord>) => void;
  onReanalyze: () => void;
}) {
  const audioSrc = sample ? convertFileSrc(sample.path) : "";
  const analysis = sample?.analysis;
  const merged = sample ? mergeUserValues(sample) : undefined;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playProgress, setPlayProgress] = useState(0);

  useEffect(() => {
    setPlayProgress(0);
  }, [sample?.id]);

  const syncProgress = () => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      setPlayProgress(0);
      return;
    }

    setPlayProgress(Math.min(1, Math.max(0, audio.currentTime / audio.duration)));
  };

  const seekWaveform = (event: MouseEvent<HTMLButtonElement>) => {
    const duration = audioRef.current?.duration || analysis?.durationSeconds || 0;
    if (!duration || !Number.isFinite(duration)) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    if (audioRef.current) {
      audioRef.current.currentTime = duration * ratio;
    }
    setPlayProgress(ratio);
  };

  if (!isOpen) {
    return (
      <aside className="rail right-rail">
        <button onClick={onToggle} title="Show inspector">
          <ChevronLeft size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-title">
          <h2 title={sample?.fileName}>{sample?.fileName ?? "Inspector"}</h2>
          <p>{sample ? `${formatBytes(sample.fileSize)} - ${sample.extension.toUpperCase()}` : "Select a sample"}</p>
        </div>
        <div className="inspector-actions">
          <button onClick={onReanalyze} disabled={!sample} title="Re-analyze selected sample">
            <RefreshCw size={15} />
          </button>
          <button onClick={onToggle} title="Hide inspector">
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="wave-panel">
        <button
          className="waveform-view"
          type="button"
          onClick={seekWaveform}
          disabled={!sample || !analysis?.waveform?.length}
          aria-label="Seek sample waveform"
          title="Click waveform to seek"
        >
          {analysis?.waveform?.length ? (
            analysis.waveform.map((value, index) => (
              <span className="wave-bar" key={index} style={{ height: `${Math.max(7, value * 100)}%` }} />
            ))
          ) : (
            <div className="wave-placeholder">
              <AudioWaveform size={28} />
            </div>
          )}
          {sample && analysis?.waveform?.length ? (
            <i className="playhead" style={{ left: `${playProgress * 100}%` }} />
          ) : null}
        </button>
        {sample && (
          <audio
            ref={audioRef}
            className="audio-player"
            controls
            src={audioSrc}
            onLoadedMetadata={syncProgress}
            onTimeUpdate={syncProgress}
            onSeeked={syncProgress}
            onEnded={() => setPlayProgress(0)}
          >
            <track kind="captions" />
          </audio>
        )}
      </div>

      <div className="detail-grid">
        <Detail label="BPM" value={sample?.userBpm || numberText(analysis?.bpm)} />
        <Detail label="Key" value={displayKey(sample)} />
        <Detail label="Pitch" value={sample?.userPitch || analysis?.pitchNote || "-"} />
        <Detail label="Length" value={formatDuration(analysis?.durationSeconds)} />
        <Detail label="Engine" value={analysis?.engine || "-"} />
        <Detail label="Type" value={analysis?.sampleType || sample?.status || "-"} />
      </div>

      <div className="edit-panel">
        <div className="panel-title">
          <SlidersHorizontal size={16} />
          <span>Metadata</span>
        </div>
        <label>
          <span>Key</span>
          <input
            value={sample?.userKey ?? analysis?.key ?? ""}
            onChange={(event) => onChange({ userKey: event.target.value, verified: false })}
          />
        </label>
        <label>
          <span>Scale</span>
          <input
            value={sample?.userScale ?? analysis?.scale ?? ""}
            onChange={(event) => onChange({ userScale: event.target.value, verified: false })}
          />
        </label>
        <label>
          <span>BPM</span>
          <input
            inputMode="decimal"
            value={sample?.userBpm ?? numberText(analysis?.bpm)}
            onChange={(event) => onChange({ userBpm: event.target.value, verified: false })}
          />
        </label>
        <label>
          <span>Pitch</span>
          <input
            value={sample?.userPitch ?? analysis?.pitchNote ?? ""}
            onChange={(event) => onChange({ userPitch: event.target.value, verified: false })}
          />
        </label>
        <button className="verify-button" disabled={!sample} onClick={() => onChange({ verified: true })}>
          <CheckCircle2 size={17} />
          <span>{sample?.verified ? "Verified" : "Mark verified"}</span>
        </button>
      </div>

      <div className="candidate-panel">
        <h3>Candidates</h3>
        <CandidateLine label="BPM" values={analysis?.bpmCandidates?.map((value) => value.toFixed(1))} />
        <CandidateLine label="Key" values={analysis?.keyCandidates} />
        <CandidateLine label="Pitch" values={merged?.pitchNote ? [merged.pitchNote] : undefined} />
      </div>

      <div className="confidence-panel">
        <ConfidenceRow label="BPM" value={analysis?.bpmConfidence} />
        <ConfidenceRow label="Key" value={analysis?.keyConfidence} />
        <ConfidenceRow label="Pitch" value={analysis?.pitchConfidence} />
      </div>

      {analysis?.warnings?.length ? (
        <div className="warnings">
          {analysis.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function CandidateLine({ label, values }: { label: string; values?: string[] }) {
  const list = values?.filter(Boolean).slice(0, 5);
  return (
    <div className="candidate-line">
      <span>{label}</span>
      <strong>{list?.length ? list.join(", ") : "-"}</strong>
    </div>
  );
}

function ConfidenceRow({ label, value }: { label: string; value?: number }) {
  return (
    <div className="confidence-row">
      <span>{label}</span>
      <div className="confidence-track">
        <i style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
      </div>
      <strong>{formatPercent(value)}</strong>
    </div>
  );
}

function ConfidenceBadge({ sample }: { sample: SampleRecord }) {
  if (sample.status === "error") return <span className="badge bad">Error</span>;
  if (sample.status === "analyzing") return <span className="badge active">Analyzing</span>;
  if (sample.verified) return <span className="badge verified">Verified</span>;

  const analysis = sample.analysis;
  const confidence = Math.max(
    analysis?.bpmConfidence ?? 0,
    analysis?.keyConfidence ?? 0,
    analysis?.pitchConfidence ?? 0
  );
  const label = confidenceLabel(confidence);
  return <span className={`badge ${label.toLowerCase()}`}>{label}</span>;
}

function needsReview(sample: SampleRecord) {
  if (sample.status === "error") return true;
  if (sample.verified) return false;
  if (!sample.analysis) return true;

  const confidence = Math.max(
    sample.analysis.bpmConfidence,
    sample.analysis.keyConfidence,
    sample.analysis.pitchConfidence
  );
  return confidence < 0.35 || sample.analysis.sampleType.includes("unknown");
}

function countForFilter(samples: SampleRecord[], filter: FilterKey) {
  return samples.filter((sample) => {
    const type = sample.analysis?.sampleType.toLowerCase() ?? "";
    switch (filter) {
      case "review":
        return needsReview(sample);
      case "loops":
        return type.includes("loop");
      case "oneshots":
        return type.includes("one-shot");
      case "tonal":
        return type.includes("tonal") || Boolean(sample.analysis?.key || sample.analysis?.pitchNote);
      case "unknown":
        return type.includes("unknown") || sample.status === "error";
      case "verified":
        return Boolean(sample.verified);
      default:
        return true;
    }
  }).length;
}

function displayKey(sample?: SampleRecord) {
  if (!sample) return "-";
  const key = sample.userKey ?? sample.analysis?.key;
  const scale = sample.userScale ?? sample.analysis?.scale;
  return key ? `${key}${scale ? ` ${scale}` : ""}` : "-";
}

function numberText(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "";
}

function mergeUserValues(sample: SampleRecord): AnalysisResult | null {
  if (!sample.analysis) return null;
  return {
    ...sample.analysis,
    key: sample.userKey || sample.analysis.key,
    scale: sample.userScale || sample.analysis.scale,
    bpm: sample.userBpm ? Number(sample.userBpm) : sample.analysis.bpm,
    pitchNote: sample.userPitch || sample.analysis.pitchNote
  };
}

export default App;
