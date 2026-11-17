import { exportDocumentHtml, printDocument } from '../export'

/** 表示中の文書を PDF(印刷) / HTML として書き出すボタン群 */
export default function ExportActions() {
  return (
    <>
      <button
        type="button"
        className="topbar-action"
        onClick={() => exportDocumentHtml()}
        title="表示中の文書を HTML で書き出す"
        aria-label="表示中の文書を HTML で書き出す"
      >
        <DownloadIcon />
      </button>
      <button
        type="button"
        className="topbar-action"
        onClick={printDocument}
        title="印刷 / PDF に保存"
        aria-label="印刷 / PDF に保存"
      >
        <PrinterIcon />
      </button>
    </>
  )
}

function PrinterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 5.5V2.5h8v3M4 11H2.5V6h11v5H12M4 9.5h8v4H4v-4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v8m0 0 3-3m-3 3L5 7M3 12.5h10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
