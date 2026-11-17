import { exportDocumentHtml, exportDocumentPdf, printDocument } from '../export'

/** 表示中の文書を PDF / HTML として書き出すボタン群 */
export default function ExportActions() {
  const downloadPdf = async () => {
    if (!(await exportDocumentPdf())) {
      // Chrome が無い環境などでは HTML 書き出しにフォールバックする
      exportDocumentHtml()
    }
  }

  return (
    <>
      <button
        type="button"
        className="topbar-action"
        onClick={() => void downloadPdf()}
        title="PDF で書き出す (headless Chrome が必要)"
        aria-label="PDF で書き出す"
      >
        <PdfIcon />
      </button>
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

function PdfIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 1.5h6L12.5 4v10.5h-9v-13Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 1.5V4h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <text x="8" y="11.2" textAnchor="middle" fontSize="4.2" fill="currentColor">
        PDF
      </text>
    </svg>
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
