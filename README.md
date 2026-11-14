# The Mystery at Prachi Mansion

## Upload to GitHub
Upload the contents of this folder to the root of your GitHub repository. Keep `server.js`, `package.json`, `render.yaml`, and the `public` folder together. Do not upload the ZIP file itself.

## Render settings
- Runtime: Node
- Root Directory: leave blank
- Build Command: `npm install`
- Start Command: `npm start`

## Refresh and reconnect
This version stores a secure reconnect token in each player's browser. After a page refresh, it attempts to restore that player to the same room. Disconnected players have 90 seconds to reconnect before their seat is removed.

## Important limitation
Room data is still held in the server's memory. A Render restart, redeploy, or server crash clears active rooms. Reconnection handles page refreshes and short network interruptions, not a server restart. Persistent rooms across server restarts require a shared database or store.
