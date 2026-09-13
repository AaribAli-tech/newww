===============================================================
  NUKETOWN  -  browser FPS
===============================================================


  HOW TO PLAY  (Windows)
  ---------------------------------------------------------

  STEP 1 - EXTRACT THIS FOLDER FIRST.

    Right-click the .zip  ->  "Extract All..."  ->  Extract.

    This step is not optional. Windows lets you look inside a
    .zip without unpacking it, but the game cannot run from in
    there. If you double-click PLAY while still inside the zip
    it will either do nothing or flash a black window and close.


  STEP 2 - Open the extracted folder and double-click:

        PLAY

    (it may show as PLAY.bat depending on your settings)


  STEP 3 - A black window opens and your browser launches.

    LEAVE THE BLACK WINDOW OPEN while you play.
    It is the little server that feeds the game to your browser.
    Closing it stops the game. Close it when you are finished.


  STEP 4 - Click the game once to lock your mouse, and go.


  ---------------------------------------------------------
  CONTROLS
  ---------------------------------------------------------

    W A S D .......... move
    Mouse ............ look
    Left click ....... shoot
    Right click ...... aim down sights
    Shift ............ sprint
    Ctrl / C ......... crouch
    Space ............ jump
    R ................ reload
    1 2 3 4 .......... switch weapon  (or scroll wheel)
    Z / X ............ UAV / Airstrike  (when earned)
    V ................ Tactical Nuke   (15 kills, Team Deathmatch only)
    Tab .............. scoreboard
    Esc .............. pause
    F ................ show FPS / performance readout


  ---------------------------------------------------------
  MODES
  ---------------------------------------------------------

    TEAM DEATHMATCH   5v5, respawns on, first to 75 kills.
                      Killstreaks and the Tactical Nuke.

    ROUND CONTROL     3v3, ONE LIFE per round, first to 3
                      rounds. When you die you spectate a
                      teammate - click to switch between them.
                      There is a "skip round" button in the
                      bottom-right corner.


  ---------------------------------------------------------
  IF SOMETHING GOES WRONG
  ---------------------------------------------------------

  "Windows protected your PC" / SmartScreen popup
      Click "More info" then "Run anyway". This happens to any
      unsigned .bat file. You can read PLAY.bat and
      game\server.ps1 in Notepad - they are both short and
      plain text, nothing is hidden.

  Black window opens then closes instantly
      You are almost certainly still inside the .zip.
      Go back and do STEP 1.

  Browser did not open on its own
      Look in the black window - it prints an address like
      http://localhost:8420 - paste that into your browser.

  The game runs slowly
      Press F to see your frame rate. It starts on Low quality
      and raises itself if your machine can handle it. You can
      also set it by hand under Controls in the main menu.
      Dropping Field of View helps too.

  Nothing loads / stuck on the loading bar
      The game pulls its 3D engine from the internet, so you
      need to be online the first time you run it.


  ---------------------------------------------------------

  Runs on Windows with no install required - it uses
  PowerShell, which is already on your PC. No Python, no
  Node, nothing to download.

  Best in Chrome or Edge.

===============================================================
