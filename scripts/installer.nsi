; ============================================================================
;  POS Pro — مثبّت ويندوز (NSIS)
;  التثبيت لكل مستخدم داخل %LOCALAPPDATA%\Programs فلا يحتاج صلاحيات مدير،
;  وينشئ اختصارًا على سطح المكتب وفي قائمة ابدأ، ويُسجّل إزالة التثبيت.
; ============================================================================
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "2.1.0"
!endif
!ifndef BUILD
  !define BUILD "b000"
!endif
!ifndef APP_DIR
  !define APP_DIR "dist/POS Pro-win32-x64"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "dist/POS-Pro-Setup.exe"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "build/icon.ico"
!endif

Name "POS Pro — نظام نقاط البيع"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\POS Pro"
InstallDirRegKey HKCU "Software\POSPro" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "POS Pro — عماد عقلان | عدن"

VIProductVersion "2.1.0.0"
VIAddVersionKey "ProductName" "POS Pro"
VIAddVersionKey "FileDescription" "POS Pro — نظام نقاط البيع"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "عماد عقلان — عدن"
VIAddVersionKey "LegalCopyright" "عماد عقلان"

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "تثبيت POS Pro"
!define MUI_WELCOMEPAGE_TEXT "سيتم تثبيت نظام نقاط البيع POS Pro على هذا الجهاز.$\r$\n$\r$\nبياناتك الحالية والنسخ الاحتياطية لا تتأثر بالتثبيت."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\POS Pro.exe"
!define MUI_FINISHPAGE_RUN_TEXT "تشغيل POS Pro الآن"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Arabic"

Section "POS Pro" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; لا يمكن استبدال ملفات برنامج يعمل: نطلب إغلاقه أولًا بدل تثبيت ناقص
  ClearErrors
  FileOpen $0 "$INSTDIR\POS Pro.exe" a
  IfErrors isRunning
  FileClose $0
  Goto notRunning
  isRunning:
    MessageBox MB_ICONSTOP|MB_OK "POS Pro يعمل الآن.$\r$\n$\r$\nأغلق البرنامج من زر الإغلاق ثم أعد تشغيل المثبّت."
    Abort
  notRunning:

  ; إزالة بقايا تحديث سابق حتى لا تظهر رسائل قديمة بعد التثبيت
  RMDir /r "$INSTDIR\resources\update-pending"
  Delete "$INSTDIR\resources\update-result.json"
  Delete "$INSTDIR\resources\app.asar.backup"

  File /r "${APP_DIR}/*.*"

  ; مفاتيح التعريف (للتحديث المحلي ومعرفة مسار التثبيت)
  WriteRegStr HKCU "Software\POSPro" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\POSPro" "Version" "${VERSION}"
  WriteRegStr HKCU "Software\POSPro" "Build" "${BUILD}"

  ; اختصارات التشغيل
  CreateShortCut "$DESKTOP\POS Pro.lnk" "$INSTDIR\POS Pro.exe"
  CreateDirectory "$SMPROGRAMS\POS Pro"
  CreateShortCut "$SMPROGRAMS\POS Pro\POS Pro.lnk" "$INSTDIR\POS Pro.exe"

  ; إزالة التثبيت
  WriteUninstaller "$INSTDIR\Uninstall POS Pro.exe"
  CreateShortCut "$SMPROGRAMS\POS Pro\إزالة التثبيت.lnk" "$INSTDIR\Uninstall POS Pro.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "DisplayName" "POS Pro — نظام نقاط البيع"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "DisplayVersion" "${VERSION} (${BUILD})"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "Publisher" "عماد عقلان — عدن"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "DisplayIcon" "$INSTDIR\POS Pro.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "UninstallString" '"$INSTDIR\Uninstall POS Pro.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  ; حذف البرنامج فقط — تبقى قاعدة البيانات والنسخ الاحتياطية في مجلد بيانات المستخدم
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\POS Pro.lnk"
  RMDir /r "$SMPROGRAMS\POS Pro"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\POSPro"
  DeleteRegKey HKCU "Software\POSPro"
SectionEnd
