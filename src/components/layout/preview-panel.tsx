import { useEffect, useCallback, useRef, useState } from "react"
import { X, Save, Check } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { readFile, writeFile } from "@/commands/fs"
import { getFileCategory, isBinary } from "@/lib/file-types"
import { WikiEditor } from "@/components/editor/wiki-editor"
import { FilePreview } from "@/components/editor/file-preview"
import { getFileName } from "@/lib/path-utils"
import { Button } from "@/components/ui/button"

export function PreviewPanel() {
  const selectedFile = useWikiStore((s) => s.selectedFile)
  const fileContent = useWikiStore((s) => s.fileContent)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const manualSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle")
  const currentContentRef = useRef(fileContent)

  useEffect(() => {
    currentContentRef.current = fileContent
  }, [fileContent])

  useEffect(() => {
    if (!selectedFile) {
      setFileContent("")
      return
    }

    const category = getFileCategory(selectedFile)

    if (isBinary(category)) {
      setFileContent("")
      return
    }

    readFile(selectedFile)
      .then(setFileContent)
      .catch((err) => setFileContent(`Error loading file: ${err}`))
  }, [selectedFile, setFileContent])

  const handleSave = useCallback(
    (markdown: string) => {
      currentContentRef.current = markdown
      if (!selectedFile) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        writeFile(selectedFile, markdown).catch((err) =>
          console.error("Failed to save:", err)
        )
      }, 1000)
    },
    [selectedFile]
  )

  const handleManualSave = useCallback(async () => {
    if (!selectedFile) return
    setSaveStatus("saving")
    try {
      await writeFile(selectedFile, currentContentRef.current)
      setSaveStatus("saved")
      if (manualSaveTimerRef.current) clearTimeout(manualSaveTimerRef.current)
      manualSaveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 1500)
    } catch (err) {
      console.error("Failed to save:", err)
      setSaveStatus("idle")
    }
  }, [selectedFile])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (manualSaveTimerRef.current) clearTimeout(manualSaveTimerRef.current)
    }
  }, [])

  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to preview
      </div>
    )
  }

  const category = getFileCategory(selectedFile)
  const fileName = getFileName(selectedFile)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground" title={selectedFile}>
          {fileName}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={handleManualSave}
            disabled={saveStatus === "saving"}
          >
            {saveStatus === "saved" ? (
              <>
                <Check className="h-3.5 w-3.5" /> 已保存
              </>
            ) : saveStatus === "saving" ? (
              <>
                <Save className="h-3.5 w-3.5 animate-pulse" /> 保存中...
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" /> 保存
              </>
            )}
          </Button>
          <button
            onClick={() => setSelectedFile(null)}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {category === "markdown" ? (
          <WikiEditor
            key={selectedFile}
            content={fileContent}
            onSave={handleSave}
          />
        ) : (
          <FilePreview
            key={selectedFile}
            filePath={selectedFile}
            textContent={fileContent}
          />
        )}
      </div>
    </div>
  )
}
