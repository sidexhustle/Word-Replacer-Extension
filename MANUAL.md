# Word Replacer — Install & Use

Word Replacer shows your own words on every website in Vivaldi. For example, it can show
"colour" wherever a page says "color". Only what you see changes, and nothing is sent anywhere.

## Install

1. **Get this project folder.** On GitHub: **Code → Download ZIP**, then **Extract All**.
2. **Run the script for your computer:**
   - **Windows:** double-click `make-extension-windows.cmd`. If Windows asks, choose **Run**.
   - **Ubuntu / WSL:** run `bash make-extension-ubuntu.sh`

   The script makes `word-replacer-extension.zip` and the **extension folder**, shows where they
   are, and copies the folder path to the clipboard. Usually the folder is
   `C:\Users\<you>\VivaldiExtensions\word-replacer`, or `~/VivaldiExtensions/word-replacer` on Ubuntu.
3. **In Vivaldi:**
   1. Open `vivaldi://extensions`.
   2. Turn on **Developer mode**.
   3. Click **Load unpacked**, paste the folder path, and choose **Select Folder**.

A **⇄** button appears next to the address bar. Keep Developer mode on, and don't delete the folder.

## Use

- **Add your words:** click **⇄ → Manage rules… → + Add rule**, then fill in **Find** and
  **Replace with**. It saves by itself and works right away.
- **Quick add:** select a word on any page, right-click it → **Replace "…" with…**
- **Match:**
  - **Anywhere** (default): also changes the word inside other words.
  - **Word + endings**: only where a word starts.
  - **Whole word**: only the exact word.

  The **See the difference** box shows how each one works. The 3 example rules are switched off:
  tick one to try it, or delete them.
- **Turn off on one website:** click **⇄** and switch off **Active on …**. You can also right-click
  the page → **Word Replacer: turn off/on for this site**.
- **Turn off everywhere:** click **⇄** and switch off **Enabled everywhere**.

## After you change something

- **Changed words in Vivaldi:** nothing to do.
- **Changed the project files, or got a new version:**
  1. Run the script again.
  2. In `vivaldi://extensions`, click **⟳** (reload) on Word Replacer.

## Another computer

- **Install it:** copy `word-replacer-extension.zip` over, choose **Extract All** into a folder you
  keep, then use **Load unpacked** on that folder. You can also copy the project and run the script there.
- **Copy your words:** **Manage rules… → Export rules (.json)** on the first computer, then
  **Import file…** on the other one.
