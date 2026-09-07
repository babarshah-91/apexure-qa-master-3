import { Link2, Key, Globe } from "lucide-react";
import { Input } from "@/components/ui/input";

interface ScanInputsProps {
  sourceType: "figma" | "html";
  onSourceTypeChange: (v: "figma" | "html") => void;
  figmaUrl: string;
  figmaToken: string;
  htmlFile: File | null;
  webUrl: string;
  onFigmaUrlChange: (v: string) => void;
  onFigmaTokenChange: (v: string) => void;
  onHtmlFileChange: (file: File | null) => void;
  onWebUrlChange: (v: string) => void;
}

export const ScanInputs = ({
  sourceType,
  onSourceTypeChange,
  figmaUrl,
  figmaToken,
  htmlFile,
  webUrl,
  onFigmaUrlChange,
  onFigmaTokenChange,
  onHtmlFileChange,
  onWebUrlChange,
}: ScanInputsProps) => {
  return (
    <div className="glass-card-static p-5 space-y-4">
      {/* Source Type Selector */}
      <div className="flex space-x-2 border-b border-border pb-3">
        <button
          onClick={() => onSourceTypeChange("figma")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            sourceType === "figma"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          Figma Source
        </button>
        <button
          onClick={() => onSourceTypeChange("html")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            sourceType === "html"
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          Local HTML File Source
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source spec side */}
        <div className="space-y-3">
          <h3 className="font-display font-bold text-sm uppercase tracking-widest text-muted-foreground">
            {sourceType === "figma" ? "Figma Source" : "Local HTML Source"}
          </h3>
          
          {sourceType === "figma" ? (
            <div className="space-y-2">
              <div className="relative">
                <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="https://www.figma.com/design/..."
                  value={figmaUrl}
                  onChange={(e) => onFigmaUrlChange(e.target.value)}
                  className="pl-9"
                />
              </div>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="password"
                  placeholder="Figma Personal Access Token"
                  value={figmaToken}
                  onChange={(e) => onFigmaTokenChange(e.target.value)}
                  className="pl-9"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative flex flex-col justify-center border-2 border-dashed border-muted-foreground/25 hover:border-primary/50 transition-colors rounded-lg p-4 cursor-pointer">
                <input
                  type="file"
                  accept=".html"
                  id="html-file-input"
                  onChange={(e) => onHtmlFileChange(e.target.files?.[0] || null)}
                  className="hidden"
                />
                <label
                  htmlFor="html-file-input"
                  className="flex flex-col items-center justify-center space-y-2 cursor-pointer w-full text-center"
                >
                  <Globe className="h-8 w-8 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {htmlFile ? htmlFile.name : "Click to select local HTML file"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Only .html files are supported
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Web page side */}
        <div className="space-y-3">
          <h3 className="font-display font-bold text-foreground text-sm uppercase tracking-widest text-muted-foreground">Target Web Page</h3>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="https://www.example.com/page"
              value={webUrl}
              onChange={(e) => onWebUrlChange(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
