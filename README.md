# Readback

Readback turns the page in your active browser tab into a short learning quiz. It uses the approved **Stack** interaction: one question at a time, with each answered card moving up.

## What it does

- Makes 3, 5, 7, or 10 multiple-choice questions.
- Uses 2 to 5 answer options.
- Supports Recall, Explain, Apply, and Challenge levels. Challenge questions combine source ideas in a new scenario, comparison, or counterfactual.
- Shows all quiz controls on the start screen and saves changes automatically.
- Reads useful page text, visible diagrams, and meaningful images.
- Can make an image question when the visual adds learning value.
- Always writes the quiz in English.
- Uses `gpt-5.6-luna` with low reasoning.
- Keeps the API key in a local service. The key is never inside the extension.
- Does not keep quiz history, page content, or analytics.
- Keeps each open tab's quiz and answers separate for the current browser session.

## Start it

1. Double-click `start-readback.command`.
2. Keep the small Terminal window open while you use Readback.

Your existing `.env.local` file at the project root supplies the API key. Do not move that key into the extension folder.

## Install it in Vivaldi

1. Open `vivaldi://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder inside this Readback folder.
5. Pin Readback. Click its toolbar button on any normal webpage. The quiz starts at once.

You can also use Vivaldi's permanent Readback panel. The first time, select **Allow website access** and approve the browser prompt. Vivaldi needs this permission because opening a permanent panel does not grant access to the current page. Readback still reads and sends a page only after you start a quiz.

Chrome uses the same steps at `chrome://extensions`.

## Private by design

Readback sends data only after you click **Make my quiz**. It sends the readable page text, the visible page capture, and up to three useful page images to OpenAI. The local service binds only to `127.0.0.1`. It does not log page content. The OpenAI request uses `store: false`.

Browser system pages, extension stores, and some protected pages cannot be read. On those pages, open a normal website and try again.

## Stop it

Close the Readback Terminal window or press Control-C in it.

## Verified

- Real GPT-5.6 Luna requests and strict quiz output.
- English quiz output from a Spanish source.
- Resistance to instructions hidden inside webpage text.
- A chart-based visual question.
- Settings, Back/Next motion, scoring, retry, and answer review.
- Extension loading and side-panel support in Chrome for Testing and Vivaldi.
