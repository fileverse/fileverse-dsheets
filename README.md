# Fileverse dSheet

[![NPM](https://img.shields.io/npm/v/@fileverse-dev/dsheet)](https://www.npmjs.com/package/@fileverse-dev/dsheet)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

[dsheets.new](http://dsheets.new/) is your end-to-end encrypted alternative to Google Sheets & Excel. Use it to read, manipulate, and even write financial data, in real-time. Built on the same middleware as ddocs.new, the app is privacy-focused, sovereign, and gives you full control over your data. 

## 𓆣 Features include:
- End-to-end encryption
- Local & peer-to-peer storage
- Query live data from APIs & even smart contracts
- Enable dark mode and other color themes
- Use a familiar spreadsheets interface & functions (VLOOKUP, INDEX, MATCH…)
- Granular access permissions (e.g., give view, comment, edit, suggest access to specific email addresses)

<img width="1532" height="974" alt="dsheetsnew" src="https://github.com/user-attachments/assets/8bd67463-e999-41f4-b414-9d017fbf9466" />


## Installation

Install via npm to get started:

```bash
npm install @fileverse-dev/dsheet
```

## Setup

### 1. Import

Add the following imports

```typescript
import DsheetEditor from '@fileverse-dev/dsheet';
import '@fileverse-dev/dsheet/styles';
```

### 2. Configure Tailwind

Add to your `tailwind.config.js`:

```javascript
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./node_modules/@fileverse-dev/dsheet/dist/index.es.js"
  ]
}
```

### 3. Basic Usage

```typescript
function App() {
  const [data, setData] = useState({});

  return (
    <DsheetEditor
      isAuthorized={true}
      dsheetId="my-sheet-id"
      onChange={(updateData) => setData(updateData)}
    />
  );
}
```

## Props Reference

### Required Props

| Prop | Type | Description |
|------|------|-------------|
| `isAuthorized` | `boolean` | Authorization status for the user |
| `dsheetId` | `string` | Unique identifier for collaboration room |

### Optional Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onChange` | `(data: SheetUpdateData, encodedUpdate?: string) => void` | - | Callback when sheet data changes |
| `onContentUpdate` | `() => void` | - | Cheap throttled callback that does not encode or reconstruct the sheet |
| `portalContent` | `string` | - | Encoded initial sheet data |
| `isReadOnly` | `boolean` | `false` | Enable read-only mode |
| `allowComments` | `boolean` | `false` | Enable comments (requires `isReadOnly=true`) |
| `username` | `string` | - | Username for collaboration |
| `isCollaborative` | `boolean` | `false` | Enable collaborative features |
| `enableWebrtc` | `boolean` | `true` | Enable WebRTC for P2P collaboration |
| `enableIndexeddbSync` | `boolean` | `true` | Enable local IndexedDB persistence |
| `isTemplateOpen` | `boolean` | - | Template sidebar state |
| `selectedTemplate` | `string` | - | Selected template identifier |
| `onboardingComplete` | `boolean` | - | Onboarding completion status |
| `sheetEditorRef` | `RefObject<WorkbookInstance>` | - | External ref to editor instance |

### Advanced Props

| Prop | Type | Description |
|------|------|-------------|
| `renderNavbar` | `(editorValues?: EditorValues) => JSX.Element` | Custom navbar renderer |
| `onboardingHandler` | `OnboardingHandlerType` | Custom onboarding logic |
| `dataBlockApiKeyHandler` | `DataBlockApiKeyHandlerType` | API key handler for data blocks |
| `getCommentCellUI` | `(row: number, column: number, dragHandler: CommentUIDragFn) => void` | Custom comment UI handler |
| `commentData` | `Object` | Comment data for cells |
| `toggleTemplateSidebar` | `() => void` | Template sidebar toggle handler |
| `storeApiKey` | `(apiKeyName: string) => void` | API key storage handler |
| `onDataBlockApiResponse` | `(dataBlockName: string) => void` | Data block API response handler |
| `onDuneChartEmbed` | `() => void` | Dune chart embed handler |
| `onSheetCountChange` | `(sheetCount: number) => void` | Sheet count change handler |

### UI State Props

| Prop | Type | Description |
|------|------|-------------|
| `setShowFetchURLModal` | `Dispatch<SetStateAction<boolean>>` | URL fetch modal state setter |
| `setFetchingURLData` | `(fetching: boolean) => void` | URL fetching state setter |
| `setInputFetchURLDataBlock` | `Dispatch<SetStateAction<string>>` | URL input state setter |
| `setForceSheetRender` | `Dispatch<SetStateAction<number>>` | Force re-render trigger |

## Examples

### Read-Only Viewer

```typescript
<DsheetEditor
  isAuthorized={true}
  dsheetId="viewer-sheet"
  isReadOnly={true}
  allowComments={true}
  portalContent={encodedData}
  onChange={() => {}}
/>
```

### Collaborative Editor

```typescript
<DsheetEditor
  isAuthorized={true}
  dsheetId="collab-sheet"
  username="john-doe"
  isCollaborative={true}
  enableWebrtc={true}
  onChange={(data) => console.log('Sheet updated:', data)}
/>
```

### Custom Navbar

```typescript
<DsheetEditor
  isAuthorized={true}
  dsheetId="custom-sheet"
  renderNavbar={(editorValues) => (
    <div className="flex items-center gap-4">
      <h1>My Custom Sheet</h1>
      <button onClick={() => editorValues?.sheetEditorRef.current?.exportToExcel()}>
        Export
      </button>
    </div>
  )}
/>
```

### With Templates

```typescript
<DsheetEditor
  isAuthorized={true}
  dsheetId="template-sheet"
  selectedTemplate="financial-budget"
  isTemplateOpen={true}
  toggleTemplateSidebar={() => setTemplateOpen(!templateOpen)}
/>
```

## Development

### Run Demo

```bash
cd demo
npm install
npm run dev
```

### Build Package

```bash
npm run build
```

## TypeScript

All props are fully typed. Import types:

```typescript
import { DsheetProps, SheetUpdateData, EditorValues } from '@fileverse-dev/dsheet/types';
```

## License

AGPL-3.0
