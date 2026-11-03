# A small window for the computer-use probes to drive, so they never type into one of the
# person's own apps: a text box (named "Body"), Ctrl+S opens the real Windows Save As dialog,
# and saving writes the text to the file and puts its name in the title, as Notepad does.
#
#   powershell -NoProfile -STA -File scripts/desk-test-window.ps1 [-Title "Ember Plan Test"]
param([string]$Title = 'Ember Plan Test')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Untitled - $Title"
$form.Size = New-Object System.Drawing.Size(560, 360)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(120, 120)
$form.KeyPreview = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.Dock = 'Fill'
$box.AccessibleName = 'Body'
$box.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$form.Controls.Add($box)

$save = {
  $dlg = New-Object System.Windows.Forms.SaveFileDialog
  $dlg.Title = 'Save As'
  $dlg.Filter = 'Text (*.txt)|*.txt|All files (*.*)|*.*'
  $dlg.FileName = '*.txt'
  if ($dlg.ShowDialog($form) -eq 'OK') {
    [System.IO.File]::WriteAllText($dlg.FileName, $box.Text)
    $form.Text = "$([System.IO.Path]::GetFileName($dlg.FileName)) - $Title"
  }
}
$form.Add_KeyDown({
  param($s, $e)
  if ($e.Control -and $e.KeyCode -eq 'S') { $e.SuppressKeyPress = $true; & $save }
})
[void]$form.ShowDialog()
