$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repository = Split-Path $PSScriptRoot -Parent
$artDirectory = Join-Path $repository 'apps\desktop\src-tauri\installer'
$source = [System.Drawing.Image]::FromFile((Join-Path $artDirectory 'welcome-art.png'))
$sidebar = New-Object System.Drawing.Bitmap(328, 628)
$graphics = [System.Drawing.Graphics]::FromImage($sidebar)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($source, 0, 0, 328, 628)
$sidebar.Save((Join-Path $artDirectory 'sidebar.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$graphics.Dispose()
$sidebar.Dispose()
$source.Dispose()

$header = New-Object System.Drawing.Bitmap(300, 114)
$graphics = [System.Drawing.Graphics]::FromImage($header)
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#FFF7F3'))
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$icon = [System.Drawing.Image]::FromFile((Join-Path $repository 'apps\desktop\src-tauri\icons\128x128@2x.png'))
$graphics.DrawImage($icon, 14, 13, 84, 84)
$font = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#57323F'))
$graphics.DrawString("Cupcake`nChat", $font, $brush, 112, 21)
$header.Save((Join-Path $artDirectory 'header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$brush.Dispose()
$font.Dispose()
$icon.Dispose()
$graphics.Dispose()
$header.Dispose()
