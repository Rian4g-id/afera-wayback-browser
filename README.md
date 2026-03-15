# 🕰️ Wayback Browser

Fast and lightweight desktop browser for Internet Archive Wayback Machine.

## Features

- ⚡ **Fast API Access** - Direct CDX API, no heavy web UI
- 📅 **Calendar View** - Visual month-by-month navigation
- 🔗 **Quick Open** - Open snapshots in external browser
- 📋 **Copy URL** - Easy copy snapshot URLs
- 🎨 **Modern Dark UI** - Beautiful and easy on the eyes

## Screenshot

```
┌─────────────────────────────────────────────────────┐
│  🕰️ Wayback Browser                                 │
├─────────────────────────────────────────────────────┤
│  [example.com                    ] [🔍 Search]      │
├─────────────────────────────────────────────────────┤
│  📊 Total: 156 │ 📅 First: 2018 │ 🕐 Last: 2024    │
├─────────────────────────────────────────────────────┤
│  [2024] [2023] [2022] [2021] [2020] ...            │
├─────────────────────────────────────────────────────┤
│  📅 Calendar 2024          │  📋 Snapshots (42)    │
│  ┌────┬────┬────┬────┐    │  📸 Jan 05 [🔗 Open]  │
│  │Jan │Feb │Mar │Apr │    │  📸 Jan 12 [🔗 Open]  │
│  │ 12 │ 8  │ 5  │ 3  │    │  📸 Jan 18 [🔗 Open]  │
│  └────┴────┴────┴────┘    │  ...                   │
└─────────────────────────────────────────────────────┘
```

## Installation

### Option 1: Run from source (Development)

1. Install Node.js (https://nodejs.org/)

2. Clone/extract this folder

3. Install dependencies:
```bash
cd wayback-browser
npm install
```

4. Run the app:
```bash
npm start
```

### Option 2: Build executable (.exe)

1. Install dependencies:
```bash
npm install
```

2. Build for Windows:
```bash
npm run build:win
```

3. Find the `.exe` in `dist/` folder

## Usage

1. Enter a domain (e.g., `example.com`)
2. Click **Search** or press **Enter**
3. Browse years using tabs
4. Click months to filter
5. Click **Open** to view snapshot in browser
6. Click **Copy** to copy URL

## Tech Stack

- **Electron** - Desktop app framework
- **HTML/CSS/JS** - UI
- **Wayback CDX API** - Data source

## API Used

```
https://web.archive.org/cdx/search/cdx?url={domain}&output=json
```

Returns same data as web.archive.org but faster (no UI overhead).

## License

MIT
