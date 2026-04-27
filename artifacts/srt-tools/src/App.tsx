import { useEffect, useRef, useState } from "react";
import SrtNoteTab from "@/tabs/SrtNoteTab";
import VoiceTrimmerTab from "@/tabs/VoiceTrimmerTab";
import AiAudioTab from "@/tabs/AiAudioTab";

type Tab = "note" | "aiAudio" | "audio";

const TABS: { id: Tab; label: string }[] = [
  { id: "note", label: "SRT Note" },
  { id: "aiAudio", label: "Ai Audio" },
  { id: "audio", label: "Audio Spliter" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("note");
  const [spliterIncomingAudio, setSpliterIncomingAudio] = useState<{
    files: File[];
    key: number;
    autoSplit?: boolean;
  }>({ files: [], key: 0 });

  const autoRunRef = useRef(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = localStorage.getItem("srt-tools-theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("srt-tools-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleSelectTab = (id: Tab) => {
    setActiveTab(id);
  };

  useEffect(() => {
    const onPoolLoaded = (e: Event) => {
      if (!autoRunRef.current) return;
      const detail = (e as CustomEvent<{ done: number; total: number }>).detail;
      if (!detail || detail.done === 0) {
        autoRunRef.current = false;
        return;
      }
      window.dispatchEvent(new CustomEvent("srt-tools:aiaudio-load-spliter"));
    };
    window.addEventListener("srt-tools:aiaudio-pool-loaded", onPoolLoaded);
    return () => window.removeEventListener("srt-tools:aiaudio-pool-loaded", onPoolLoaded);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900 overflow-hidden">
      <header className="bg-white dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-20 shrink-0">
        <div className="px-4">
          <div className="max-w-7xl mx-auto flex items-center gap-3 py-3">
            <div className="flex items-center justify-center w-8 h-8 bg-blue-600 rounded-lg shrink-0">
              <svg className="w-4.5 h-4.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14.5 2.5a2 2 0 00-2-2h-1a2 2 0 00-2 2v1h5v-1zm-5 3v1.5a.5.5 0 01-.5.5H7.5A2.5 2.5 0 005 10v9a2.5 2.5 0 002.5 2.5h9A2.5 2.5 0 0019 19v-9a2.5 2.5 0 00-2.5-2.5H15a.5.5 0 01-.5-.5V5.5h-5z" />
              </svg>
            </div>
            <span className="text-base font-bold text-gray-900 dark:text-gray-100">
              SRT Tools
            </span>
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to day mode" : "Switch to night mode"}
              title={theme === "dark" ? "Day mode" : "Night mode"}
              className="flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === "dark" ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
          </div>

          <nav className="flex gap-0 -mb-px overflow-x-auto px-2 justify-center flex-wrap">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                className={`flex items-center gap-1 px-2.5 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* SRT Note */}
      <div
        style={{ display: activeTab === "note" ? "flex" : "none" }}
        className="flex-col flex-1 overflow-hidden"
      >
        <SrtNoteTab
          incomingText=""
          incomingName=""
          incomingKey={0}
          onRunToAiAudio={(lines, label) => {
            autoRunRef.current = true;
            window.dispatchEvent(
              new CustomEvent("srt-tools:aiaudio-set-content", {
                detail: { lines, label },
              }),
            );
            handleSelectTab("aiAudio");
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent("srt-tools:aiaudio-cut"));
              window.setTimeout(() => {
                window.dispatchEvent(new CustomEvent("srt-tools:aiaudio-load-pool"));
              }, 250);
            }, 250);
          }}
        />
      </div>

      {/* Ai Audio */}
      <div
        style={{ display: activeTab === "aiAudio" ? "flex" : "none" }}
        className="flex-col flex-1 overflow-y-auto"
      >
        <AiAudioTab
          onSendToSpliter={(files) => {
            const autoSplit = autoRunRef.current;
            autoRunRef.current = false;
            setSpliterIncomingAudio({ files, key: Date.now(), autoSplit });
            handleSelectTab("audio");
          }}
        />
      </div>

      {/* Audio Spliter */}
      <div
        style={{ display: activeTab === "audio" ? "flex" : "none" }}
        className="flex-col flex-1 overflow-y-auto"
      >
        <VoiceTrimmerTab incomingAudioFiles={spliterIncomingAudio} />
      </div>
    </div>
  );
}
