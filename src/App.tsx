import {
  Activity,
  CheckCircle2,
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
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Table2,
  AudioWaveform,
  Loader2,
  FolderPlus,
  FilePlus,
  Trash2,
  ChevronDown,
  AlertTriangle,
  FolderSearch,
  Palette,
  Check
} from "lucide-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

type ActiveAnalysis = {
  sampleId: string;
  fileName: string;
  path: string;
  folder: string;
  current: number;
  total: number;
  overallPercent: number;
  filePercent: number;
  stageMessage: string;
};

type ProgressPayload = {
  path: string;
  stage: string;
  message: string;
  percent: number;
};

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

type ThemeKey =
  | "dark"
  | "light"
  | "cyberpunk"
  | "analog"
  | "slate"
  | "dracula"
  | "nord"
  | "monokai"
  | "solarized"
  | "emerald"
  | "sunset";

interface ThemeOption {
  key: ThemeKey;
  label: string;
  desc: string;
  previewColors: [string, string, string];
}

const THEMES: ThemeOption[] = [
  {
    key: "dark",
    label: "Dark Studio",
    desc: "Pro DAW dark console & teal",
    previewColors: ["#111419", "#1d222b", "#14b8a6"],
  },
  {
    key: "light",
    label: "Light Studio",
    desc: "Clean Nordic studio & slate",
    previewColors: ["#eef1f4", "#ffffff", "#167c80"],
  },
  {
    key: "cyberpunk",
    label: "Midnight Cyber",
    desc: "Synthwave obsidian & neon violet",
    previewColors: ["#0b0d17", "#171b30", "#a855f7"],
  },
  {
    key: "analog",
    label: "Warm Analog",
    desc: "Vintage tape console & amber brass",
    previewColors: ["#181513", "#29241f", "#d97706"],
  },
  {
    key: "slate",
    label: "Slate Minimal",
    desc: "Monochrome graphite & ice blue",
    previewColors: ["#0f1115", "#1d212b", "#38bdf8"],
  },
  {
    key: "dracula",
    label: "Dracula",
    desc: "Gothic lilac & soft violet",
    previewColors: ["#1e1f29", "#282a36", "#bd93f9"],
  },
  {
    key: "nord",
    label: "Nord Frost",
    desc: "Arctic polar night & glacier frost",
    previewColors: ["#242933", "#2e3440", "#88c0d0"],
  },
  {
    key: "monokai",
    label: "Monokai Pro",
    desc: "Charcoal espresso & chartreuse lime",
    previewColors: ["#19181a", "#2a262a", "#a9dc76"],
  },
  {
    key: "solarized",
    label: "Solarized Deep",
    desc: "Abyssal oceanic teal & amber",
    previewColors: ["#001e26", "#073642", "#2aa198"],
  },
  {
    key: "emerald",
    label: "Emerald Matrix",
    desc: "Stealth forest & vivid emerald",
    previewColors: ["#090e0b", "#16241a", "#10b981"],
  },
  {
    key: "sunset",
    label: "Crimson Sunset",
    desc: "Twilight aubergine & vibrant coral",
    previewColors: ["#140d17", "#26162d", "#f43f5e"],
  },
];

function App() {
  const [samples, setSamples] = useState<SampleRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [activeAnalysis, setActiveAnalysis] = useState<ActiveAnalysis | null>(null);
  const [notice, setNotice] = useState("Open a folder to begin.");
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [isImportMenuOpen, setIsImportMenuOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const cancelRequested = useRef(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  const [theme, setTheme] = useState<ThemeKey>(() => {
    const saved = localStorage.getItem("sample_studio_theme") as ThemeKey | null;
    const validThemes: ThemeKey[] = [
      "dark",
      "light",
      "cyberpunk",
      "analog",
      "slate",
      "dracula",
      "nord",
      "monokai",
      "solarized",
      "emerald",
      "sunset",
    ];
    return saved && validThemes.includes(saved) ? saved : "dark";
  });

  useEffect(() => {
    localStorage.setItem("sample_studio_theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setIsImportMenuOpen(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setIsExportMenuOpen(false);
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target as Node)) {
        setIsThemeMenuOpen(false);
      }
    };
    if (isImportMenuOpen || isExportMenuOpen || isThemeMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isImportMenuOpen, isExportMenuOpen, isThemeMenuOpen]);

  const openFileLocation = async (filePath?: string) => {
    if (!filePath) return;
    try {
      await invoke("open_file_location", { path: filePath });
    } catch (err) {
      console.error("Failed to open file location:", err);
      setNotice(`Failed to open location: ${String(err)}`);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const unlistenPromise = listen<ProgressPayload>("analysis-progress", (event) => {
      if (!isMounted) return;
      const { path, message, percent } = event.payload;
      setActiveAnalysis((prev) => {
        if (!prev) return null;
        if (prev.path && prev.path !== path) return prev;
        return {
          ...prev,
          stageMessage: message,
          filePercent: Math.max(prev.filePercent, percent),
        };
      });
    });

    return () => {
      isMounted = false;
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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

  const [loadedSources, setLoadedSources] = useState<string[]>([]);

  // Auto-restore library from database on startup
  useEffect(() => {
    const loadSaved = async () => {
      try {
        const saved = await invoke<SampleRecord[]>("load_library");
        if (saved && saved.length > 0) {
          setSamples(saved);
          setSelectedId(saved[0]?.id ?? null);
          const cachedCount = saved.filter((s) => s.status === "done" && s.analysis).length;
          setNotice(`Restored ${saved.length} samples from database cache (${cachedCount} analyzed).`);
        }
      } catch {
        // First run or empty database
      }
    };
    loadSaved();
  }, []);

  const mergeSamples = (existing: SampleRecord[], incoming: SampleRecord[]) => {
    const existingPaths = new Set(existing.map((s) => s.path));
    const newItems = incoming.filter((s) => !existingPaths.has(s.path));
    const combined = [...existing, ...newItems].sort((a, b) =>
      a.fileName.toLowerCase().localeCompare(b.fileName.toLowerCase())
    );
    return { merged: combined, added: newItems.length };
  };

  const openFolder = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "Open sample folder"
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;

    setNotice("Scanning folder...");
    setFolderPath(selectedPath);
    setLoadedSources([selectedPath]);
    cancelRequested.current = true;
    setIsAnalyzing(false);
    setIsPausing(false);
    setActiveAnalysis(null);

    try {
      const scanned = await invoke<SampleRecord[]>("scan_folder", { path: selectedPath });
      setSamples(scanned);
      setSelectedId(scanned[0]?.id ?? null);
      const cachedCount = scanned.filter((s) => s.status === "done" && s.analysis).length;
      setNotice(
        scanned.length
          ? `Loaded ${scanned.length} samples (${cachedCount} analyzed from cache).`
          : "No supported audio files found."
      );
    } catch (error) {
      setNotice(String(error));
    }
  };

  const addFolder = async () => {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: "Add sample folder to library"
    });

    if (!selectedPath || Array.isArray(selectedPath)) return;

    setNotice(`Scanning ${selectedPath}...`);
    try {
      const scanned = await invoke<SampleRecord[]>("scan_folder", { path: selectedPath });
      if (!scanned.length) {
        setNotice("No supported audio files found in folder.");
        return;
      }

      const { merged, added } = mergeSamples(samples, scanned);
      setSamples(merged);
      setLoadedSources((prev) => Array.from(new Set([...prev, selectedPath])));
      if (!selectedId && merged[0]) {
        setSelectedId(merged[0].id);
      }
      const cachedCount = scanned.filter((s) => s.status === "done" && s.analysis).length;
      setNotice(
        `Added ${added} new samples (${scanned.length - added} duplicates skipped, ${cachedCount} cached).`
      );
    } catch (error) {
      setNotice(String(error));
    }
  };

  const addFiles = async () => {
    const selectedPaths = await open({
      directory: false,
      multiple: true,
      title: "Add audio samples to library",
      filters: [
        {
          name: "Audio files",
          extensions: ["wav", "wave", "aif", "aiff", "flac", "mp3", "ogg", "m4a", "aac"]
        }
      ]
    });

    if (!selectedPaths) return;
    const paths = Array.isArray(selectedPaths) ? selectedPaths : [selectedPaths];
    if (!paths.length) return;

    setNotice(`Scanning ${paths.length} files...`);
    try {
      const scanned = await invoke<SampleRecord[]>("scan_files", { paths });
      if (!scanned.length) {
        setNotice("No supported audio files could be loaded.");
        return;
      }

      const { merged, added } = mergeSamples(samples, scanned);
      setSamples(merged);
      if (!selectedId && merged[0]) {
        setSelectedId(merged[0].id);
      }
      const cachedCount = scanned.filter((s) => s.status === "done" && s.analysis).length;
      setNotice(
        `Added ${added} new audio files (${scanned.length - added} duplicates skipped, ${cachedCount} cached).`
      );
    } catch (error) {
      setNotice(String(error));
    }
  };

  const clearLibrary = () => {
    cancelRequested.current = true;
    setIsAnalyzing(false);
    setIsPausing(false);
    setActiveAnalysis(null);
    setSamples([]);
    setSelectedId(null);
    setFolderPath("");
    setLoadedSources([]);
    setNotice("Library view cleared. Open or add folders/files to begin.");
  };

  const analyzeAll = async () => {
    if (!samples.length || isAnalyzing) return;

    const toAnalyze = samples.filter((sample) => sample.status !== "done" || !sample.analysis);
    const total = toAnalyze.length;

    if (total === 0) {
      setNotice("All samples have already been analyzed.");
      return;
    }

    cancelRequested.current = false;
    setIsAnalyzing(true);
    setIsPausing(false);
    setNotice(`Starting analysis of ${total} samples...`);

    let processed = 0;

    for (const sample of toAnalyze) {
      if (cancelRequested.current) break;

      processed += 1;
      const overallPercent = Math.round(((processed - 1) / total) * 100);

      setActiveAnalysis({
        sampleId: sample.id,
        fileName: sample.fileName,
        path: sample.path,
        folder: sample.folder,
        current: processed,
        total,
        overallPercent,
        filePercent: 12,
        stageMessage: "Opening audio file...",
      });

      setNotice(`Analyzing (${processed}/${total}): ${sample.fileName}`);

      setSamples((current) =>
        current.map((item) =>
          item.id === sample.id ? { ...item, status: "analyzing", error: undefined } : item
        )
      );

      // Yield 25ms to let UI paint active states and process user events smoothly
      await new Promise((resolve) => setTimeout(resolve, 25));

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

      // Small yield between samples to keep UI silky smooth and responsive
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const wasPaused = cancelRequested.current;
    setActiveAnalysis(null);
    setIsAnalyzing(false);
    setIsPausing(false);
    setNotice(wasPaused ? "Analysis paused." : `Completed analysis of ${processed} samples.`);
  };

  const pauseAnalysis = () => {
    cancelRequested.current = true;
    setIsPausing(true);
    setNotice("Finishing current file, then pausing...");
  };

  const reanalyzeSelected = async () => {
    if (!selected || isAnalyzing) return;
    setIsAnalyzing(true);
    setIsPausing(false);
    setActiveAnalysis({
      sampleId: selected.id,
      fileName: selected.fileName,
      path: selected.path,
      folder: selected.folder,
      current: 1,
      total: 1,
      overallPercent: 0,
      filePercent: 12,
      stageMessage: "Opening audio file...",
    });

    setSamples((current) =>
      current.map((item) =>
        item.id === selected.id ? { ...item, status: "analyzing", error: undefined } : item
      )
    );

    // Yield for paint
    await new Promise((resolve) => setTimeout(resolve, 25));

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
    } finally {
      setActiveAnalysis(null);
      setIsAnalyzing(false);
      setIsPausing(false);
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
    const updated = { ...selected, ...patch };
    setSamples((current) =>
      current.map((sample) => (sample.id === selected.id ? updated : sample))
    );

    invoke("save_sample_metadata", {
      path: selected.path,
      userKey: updated.userKey ?? null,
      userScale: updated.userScale ?? null,
      userBpm: updated.userBpm ?? null,
      userPitch: updated.userPitch ?? null,
      verified: Boolean(updated.verified)
    }).catch((err) => console.error("Failed to persist metadata:", err));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-info">
            <h1>Sample Key Studio</h1>
            <p title={loadedSources.join("; ") || folderPath || notice}>
              {samples.length > 0
                ? `${samples.length} samples ${
                    loadedSources.length > 1
                      ? `(${loadedSources.length} folders)`
                      : folderPath
                      ? `(${folderPath})`
                      : ""
                  } - ${notice}`
                : notice}
            </p>
          </div>
        </div>

        <div className="toolbar">
          <div className="toolbar-actions">
            {/* Open / Import Dropdown Menu */}
            <div className="dropdown-wrapper" ref={importMenuRef}>
              <button
                type="button"
                className={`primary ${isImportMenuOpen ? "active" : ""}`}
                onClick={() => setIsImportMenuOpen((prev) => !prev)}
                title="Open or add audio samples to library"
              >
                <FolderOpen size={16} />
                <span>Open</span>
                <ChevronDown size={14} className={isImportMenuOpen ? "rotate-180" : ""} />
              </button>
              {isImportMenuOpen && (
                <div className="dropdown-menu align-left">
                  <div className="menu-heading">Library Sources</div>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setIsImportMenuOpen(false);
                      openFolder();
                    }}
                  >
                    <FolderOpen size={16} />
                    <div className="dropdown-item-text">
                      <strong>Open Folder...</strong>
                      <small>Replace library with selected folder</small>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setIsImportMenuOpen(false);
                      addFolder();
                    }}
                  >
                    <FolderPlus size={16} />
                    <div className="dropdown-item-text">
                      <strong>Add Folder...</strong>
                      <small>Append samples from another folder</small>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setIsImportMenuOpen(false);
                      addFiles();
                    }}
                  >
                    <FilePlus size={16} />
                    <div className="dropdown-item-text">
                      <strong>Add Audio Files...</strong>
                      <small>Append individual sample files</small>
                    </div>
                  </button>
                </div>
              )}
            </div>
            <button onClick={analyzeAll} disabled={!samples.length || isAnalyzing} title="Analyze unanalyzed samples">
              {isAnalyzing && !isPausing ? <Loader2 size={16} className="spin text-teal" /> : <Sparkles size={16} />}
              <span>Analyze</span>
            </button>
            <button onClick={pauseAnalysis} disabled={!isAnalyzing || isPausing} title="Pause analysis">
              {isPausing ? <Loader2 size={16} className="spin" /> : <PauseCircle size={16} />}
              <span>{isPausing ? "Pausing..." : "Pause"}</span>
            </button>

            <div className="dropdown-wrapper" ref={exportMenuRef}>
              <button
                type="button"
                onClick={() => setIsExportMenuOpen((prev) => !prev)}
                disabled={!samples.length}
                title="Export sample metadata"
                className={isExportMenuOpen ? "active" : ""}
              >
                <Download size={15} />
                <span>Export</span>
                <ChevronDown size={14} className={isExportMenuOpen ? "rotate-180" : ""} />
              </button>
              {isExportMenuOpen && (
                <div className="dropdown-menu">
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      exportSamples("csv");
                    }}
                  >
                    <Download size={15} />
                    <div className="dropdown-item-text">
                      <strong>Export CSV (.csv)</strong>
                      <small>Spreadsheet with BPM, key, scale & pitches</small>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      exportSamples("json");
                    }}
                  >
                    <FileJson size={15} />
                    <div className="dropdown-item-text">
                      <strong>Export JSON (.json)</strong>
                      <small>Structured audio metadata & waveforms</small>
                    </div>
                  </button>
                </div>
              )}
            </div>

            {/* Theme Selector Menu */}
            <div className="dropdown-wrapper" ref={themeMenuRef}>
              <button
                type="button"
                onClick={() => setIsThemeMenuOpen((prev) => !prev)}
                title="Change UI Theme"
                className={isThemeMenuOpen ? "active" : ""}
              >
                <Palette size={15} />
                <span>Theme</span>
                <ChevronDown size={14} className={isThemeMenuOpen ? "rotate-180" : ""} />
              </button>
              {isThemeMenuOpen && (
                <div className="dropdown-menu theme-menu">
                  <div className="menu-heading">UI Theme</div>
                  {THEMES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={`dropdown-item theme-item ${theme === item.key ? "selected" : ""}`}
                      onClick={() => {
                        setTheme(item.key);
                        setIsThemeMenuOpen(false);
                      }}
                    >
                      <div className="theme-swatch">
                        <span style={{ background: item.previewColors[0] }} />
                        <span style={{ background: item.previewColors[1] }} />
                        <span style={{ background: item.previewColors[2] }} />
                      </div>
                      <div className="dropdown-item-text">
                        <strong>{item.label}</strong>
                        <small>{item.desc}</small>
                      </div>
                      {theme === item.key && <Check size={14} className="theme-check-icon" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsClearConfirmOpen(true)}
              disabled={!samples.length}
              title="Clear library view"
            >
              <Trash2 size={15} />
              <span>Clear</span>
            </button>
          </div>

          <div className="toolbar-right">
            {/* Side panels toggle buttons next to each other on the right */}
            <div className="panel-toggles-group">
              <button
                type="button"
                onClick={() => setIsSidebarOpen((value) => !value)}
                title={isSidebarOpen ? "Hide filters panel" : "Show filters panel"}
                className={isSidebarOpen ? "panel-btn active" : "panel-btn"}
              >
                {isSidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                <span>Filters</span>
              </button>
              <button
                type="button"
                onClick={() => setIsInspectorOpen((value) => !value)}
                title={isInspectorOpen ? "Hide inspector panel" : "Show inspector panel"}
                className={isInspectorOpen ? "panel-btn active" : "panel-btn"}
              >
                {isInspectorOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                <span>Inspector</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {isClearConfirmOpen && (
        <div className="modal-backdrop" onClick={() => setIsClearConfirmOpen(false)}>
          <div
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <div className="modal-icon-danger">
                <AlertTriangle size={20} />
              </div>
              <div className="modal-header-text">
                <h3>Clear Library?</h3>
                <p>Are you sure you want to clear loaded samples?</p>
              </div>
            </div>
            <p className="modal-desc">
              This will remove <strong>{samples.length}</strong> sample{samples.length === 1 ? "" : "s"} from your active view. Your cached analysis results in the database will be preserved.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="modal-cancel-btn"
                onClick={() => setIsClearConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-danger-btn"
                onClick={() => {
                  clearLibrary();
                  setIsClearConfirmOpen(false);
                }}
              >
                <Trash2 size={15} />
                <span>Clear Library</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <section
        className={`content-grid ${!isSidebarOpen ? "sidebar-collapsed" : ""} ${
          !isInspectorOpen ? "inspector-collapsed" : ""
        }`}
      >
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
          {activeAnalysis && (
            <div className="analysis-banner" role="region" aria-label="Analysis progress">
              <div className="analysis-banner-main">
                <div className="analysis-banner-info">
                  <div className="analysis-banner-tag">
                    <Loader2 size={13} className="spin text-teal" />
                    <span>Analyzing {activeAnalysis.current} of {activeAnalysis.total}</span>
                  </div>
                  <strong className="analysis-banner-file" title={activeAnalysis.fileName}>
                    {activeAnalysis.fileName}
                  </strong>
                </div>
                <div className="analysis-banner-stage">
                  <span>{activeAnalysis.stageMessage}</span>
                </div>
              </div>

              <div className="analysis-banner-progress">
                <div className="progress-group">
                  <div className="progress-group-header">
                    <span>Current file</span>
                    <strong>{activeAnalysis.filePercent}%</strong>
                  </div>
                  <div className="progress-track" title={`Current file: ${activeAnalysis.filePercent}%`}>
                    <div
                      className="progress-fill file-fill"
                      style={{ width: `${Math.max(5, activeAnalysis.filePercent)}%` }}
                    />
                  </div>
                </div>

                <div className="progress-group">
                  <div className="progress-group-header">
                    <span>Overall queue</span>
                    <strong>
                      {activeAnalysis.overallPercent}% ({activeAnalysis.current - 1}/{activeAnalysis.total})
                    </strong>
                  </div>
                  <div className="progress-track" title={`Overall queue: ${activeAnalysis.overallPercent}%`}>
                    <div
                      className="progress-fill queue-fill"
                      style={{ width: `${Math.max(2, activeAnalysis.overallPercent)}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="analysis-banner-actions">
                <button
                  type="button"
                  className="banner-pause-btn"
                  onClick={pauseAnalysis}
                  disabled={isPausing}
                  title="Pause analysis after current file"
                >
                  {isPausing ? <Loader2 size={13} className="spin" /> : <PauseCircle size={13} />}
                  <span>{isPausing ? "Pausing..." : "Pause"}</span>
                </button>
              </div>
            </div>
          )}

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
              {filteredSamples.map((sample) => {
                const isThisSampleAnalyzing = activeAnalysis?.sampleId === sample.id;
                return (
                  <button
                    key={sample.id}
                    className={`sample-row ${selected?.id === sample.id ? "selected" : ""} ${
                      isThisSampleAnalyzing ? "analyzing-active" : ""
                    }`}
                    onClick={() => setSelectedId(sample.id)}
                    role="row"
                  >
                    <span className="file-cell">
                      <span className="file-title-line">
                        {isThisSampleAnalyzing && <Loader2 size={13} className="spin text-teal" />}
                        <strong>{sample.fileName}</strong>
                      </span>
                      {Boolean(sample.folder && sample.folder.trim() !== "" && sample.folder !== ".") && (
                        <small>{sample.folder}</small>
                      )}
                      {isThisSampleAnalyzing && (
                        <span className="row-progress-track">
                          <span
                            className="row-progress-fill"
                            style={{ width: `${Math.max(8, activeAnalysis.filePercent)}%` }}
                          />
                        </span>
                      )}
                    </span>
                    <span>
                      {isThisSampleAnalyzing ? (
                        <span className="badge active analyzing-cell-badge">
                          <Loader2 size={11} className="spin" />
                          <span>{activeAnalysis.filePercent}%</span>
                        </span>
                      ) : (
                        sample.analysis?.sampleType ?? sample.status
                      )}
                    </span>
                    <span>{displayKey(sample)}</span>
                    <span>{sample.userPitch || sample.analysis?.pitchNote || "-"}</span>
                    <span>{sample.userBpm || sample.analysis?.bpm?.toFixed(1) || "-"}</span>
                    <span>
                      <ConfidenceBadge
                        sample={sample}
                        isAnalyzingNow={isThisSampleAnalyzing}
                        percent={isThisSampleAnalyzing ? activeAnalysis.filePercent : undefined}
                      />
                    </span>
                  </button>
                );
              })}

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
          activeAnalysis={activeAnalysis}
          onChange={updateSelected}
          onReanalyze={reanalyzeSelected}
          onOpenFileLocation={openFileLocation}
        />
      </section>
    </main>
  );
}

function Inspector({
  sample,
  isOpen,
  activeAnalysis,
  onChange,
  onReanalyze,
  onOpenFileLocation
}: {
  sample?: SampleRecord;
  isOpen: boolean;
  activeAnalysis?: ActiveAnalysis | null;
  onChange: (patch: Partial<SampleRecord>) => void;
  onReanalyze: () => void;
  onOpenFileLocation?: (path?: string) => void;
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
    return null;
  }

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-title">
          <h2 title={sample?.fileName}>{sample?.fileName ?? "Inspector"}</h2>
          <p>{sample ? `${formatBytes(sample.fileSize)} - ${sample.extension.toUpperCase()}` : "Select a sample"}</p>
        </div>
        <div className="inspector-actions">
          <button
            onClick={() => onOpenFileLocation?.(sample?.path)}
            disabled={!sample}
            title="Open file location in File Explorer"
          >
            <FolderSearch size={15} />
          </button>
          <button onClick={onReanalyze} disabled={!sample} title="Re-analyze selected sample">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {activeAnalysis && sample && activeAnalysis.sampleId === sample.id && (
        <div className="inspector-analyzing-card">
          <div className="inspector-analyzing-card-head">
            <Loader2 size={14} className="spin text-teal" />
            <strong>Analyzing sample ({activeAnalysis.filePercent}%)</strong>
          </div>
          <p>{activeAnalysis.stageMessage}</p>
          <div className="inspector-progress-track">
            <div
              className="inspector-progress-fill"
              style={{ width: `${Math.max(5, activeAnalysis.filePercent)}%` }}
            />
          </div>
        </div>
      )}

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

function ConfidenceBadge({
  sample,
  isAnalyzingNow,
  percent
}: {
  sample: SampleRecord;
  isAnalyzingNow?: boolean;
  percent?: number;
}) {
  if (sample.status === "error") return <span className="badge bad">Error</span>;
  if (isAnalyzingNow) {
    return (
      <span className="badge active analyzing-cell-badge" title="Analyzing now">
        <Loader2 size={11} className="spin" />
        <span>{percent ? `${percent}%` : "Analyzing"}</span>
      </span>
    );
  }
  if (sample.status === "analyzing") {
    return (
      <span className="badge active analyzing-cell-badge">
        <Loader2 size={11} className="spin" />
        <span>Analyzing</span>
      </span>
    );
  }
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
