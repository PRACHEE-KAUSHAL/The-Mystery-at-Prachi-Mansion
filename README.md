# The Mystery at Prachi Mansion

## Project files
- `package.json`
- `server.js`
- `render.yaml`
- `public/index.html`

## Upload to a NEW GitHub repository
1. Download and extract this ZIP.
2. Create an empty GitHub repository.
3. Upload the files inside the extracted folder. Upload the `public` folder too; keep `index.html` inside `public`.
4. Do not upload the ZIP file itself.

Your repository should look like:
```text
package.json
server.js
render.yaml
README.md
public/
  index.html
```

## Deploy on Render
1. Select **New → Web Service** and connect the new repository.
2. Build command: `npm install`
3. Start command: `npm start`
4. Deploy and wait for the service to say **Live**.
5. Open the Render URL. One player creates a room; friends open the same URL and join with the five-character code.

## Play
- At least 3 players are required.
- The host starts the game.
- One player privately receives the Suspect role; everyone else is an Investigator.
- The host opens voting; every player votes once.

## Important limitation
Active rooms are stored in server memory. If Render restarts or sleeps, active rooms disappear. Create a new room after a restart. Persistent rooms across restarts would need a shared database or Redis.

## Local run
With Node.js 18 or newer installed:
```bash
npm install
npm start
```
Then open `http://localhost:3000`.
