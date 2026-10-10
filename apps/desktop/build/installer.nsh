; GitHappens NSIS hooks (electron-builder `nsis.include`), spec 15 §6.4:
; put the `githappens` command on the *user* PATH. The installer ships resources\bin\githappens.cmd
; (electron-builder.yml win.extraResources); install appends "$INSTDIR\resources\bin" to
; HKCU\Environment\Path, uninstall removes it again (not on the silent uninstall that runs during an
; update, which reinstalls into the same directory). No plugins: plain registry + string ops.
;
; electron-builder compiles with -WX (warnings are errors), so installer-only and uninstaller-only
; functions are guarded by BUILD_UNINSTALLER to avoid "function not referenced" warnings.

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; Overridable so test/cli-shims.test.ts can compile (and on Windows run) this file against a scratch key.
!ifndef GH_ENV_KEY
  !define GH_ENV_KEY "Environment"
!endif
!ifndef GH_CLI_DIR
  !define GH_CLI_DIR "$INSTDIR\resources\bin"
!endif

Var KLPathOut
Var KLPathFound

; Splits $R1 (a PATH value) on ';' and rebuilds it without entries equal to $R0 (StrCmp is
; case-insensitive; a trailing backslash is ignored). Result in $KLPathOut, "1" in $KLPathFound when
; at least one entry was dropped. Clobbers $R2-$R5 (callers save them).
!macro GH_PATH_WITHOUT_BODY
  StrCpy $KLPathOut ""
  StrCpy $KLPathFound "0"
  StrCpy $R2 ""
  StrCpy $R5 0
  gh_next_char:
    StrCpy $R3 $R1 1 $R5
    StrCmp $R3 "" gh_segment_end
    StrCmp $R3 ";" gh_segment_end
    StrCpy $R2 "$R2$R3"
    IntOp $R5 $R5 + 1
    Goto gh_next_char
  gh_segment_end:
    StrCmp $R2 "" gh_segment_done
    StrCmp $R2 $R0 gh_segment_match
    StrCmp $R2 "$R0\" gh_segment_match
    StrCmp $KLPathOut "" 0 +3
      StrCpy $KLPathOut $R2
      Goto gh_segment_done
    StrCpy $KLPathOut "$KLPathOut;$R2"
    Goto gh_segment_done
  gh_segment_match:
    StrCpy $KLPathFound "1"
  gh_segment_done:
    StrCpy $R2 ""
    StrCmp $R3 "" gh_path_done
    IntOp $R5 $R5 + 1
    Goto gh_next_char
  gh_path_done:
!macroend

; Pushes "$R0 = dir" to the user PATH (or removes it), broadcasting WM_SETTINGCHANGE so new terminals
; see the change. PATH values too long for NSIS strings are left untouched (a truncated write would
; corrupt the user's PATH); the in-app "Install 'githappens' command" action remains as a fallback.
!macro GH_UPDATE_USER_PATH ADD
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrCpy $R0 "${GH_CLI_DIR}"
  ClearErrors
  ReadRegStr $R1 HKCU "${GH_ENV_KEY}" "Path"
  StrCpy $R2 "ok"
  ${If} ${Errors}
    ; Missing — or present but unreadable: ReadRegStr returns "" for values longer than
    ; NSIS_MAX_STRLEN, and writing then would wipe the user's PATH. Tell the two apart.
    StrCpy $R1 ""
    StrCpy $R2 "missing"
    StrCpy $R4 0
    gh_enum_value:
      ClearErrors
      EnumRegValue $R3 HKCU "${GH_ENV_KEY}" $R4
      IfErrors gh_enum_done
      StrCmp $R3 "" gh_enum_done
      StrCmp $R3 "Path" 0 +3
        StrCpy $R2 "unreadable"
        Goto gh_enum_done
      IntOp $R4 $R4 + 1
      Goto gh_enum_value
    gh_enum_done:
  ${EndIf}
  StrLen $R4 $R1
  IntOp $R5 ${NSIS_MAX_STRLEN} - 512
  ${If} $R2 == "unreadable"
  ${OrIf} $R4 >= $R5
    DetailPrint "User PATH is too long to edit safely; skipping the githappens command."
  ${Else}
    !insertmacro GH_PATH_WITHOUT_BODY
    !if "${ADD}" == "1"
      ${If} $KLPathFound != "1"
        ${If} $KLPathOut == ""
          StrCpy $KLPathOut $R0
        ${Else}
          StrCpy $KLPathOut "$KLPathOut;$R0"
        ${EndIf}
        WriteRegExpandStr HKCU "${GH_ENV_KEY}" "Path" $KLPathOut
        !ifndef GH_NO_BROADCAST
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
        !endif
        DetailPrint "Added $R0 to the user PATH."
      ${EndIf}
    !else
      ${If} $KLPathFound == "1"
        ${If} $KLPathOut == ""
          DeleteRegValue HKCU "${GH_ENV_KEY}" "Path"
        ${Else}
          WriteRegExpandStr HKCU "${GH_ENV_KEY}" "Path" $KLPathOut
        ${EndIf}
        !ifndef GH_NO_BROADCAST
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
        !endif
        DetailPrint "Removed $R0 from the user PATH."
      ${EndIf}
    !endif
  ${EndIf}
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!ifndef BUILD_UNINSTALLER
  Function KLAddCliToUserPath
    !insertmacro GH_UPDATE_USER_PATH 1
  FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
  Function un.KLRemoveCliFromUserPath
    !insertmacro GH_UPDATE_USER_PATH 0
  FunctionEnd
!endif

!macro customInstall
  Call KLAddCliToUserPath
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Call un.KLRemoveCliFromUserPath
  ${endIf}
!macroend
