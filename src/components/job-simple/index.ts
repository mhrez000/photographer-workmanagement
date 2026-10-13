/**
 * The simplified job page and its one-button actions (docs/SIMPLIFICATION-PLAN.md §5).
 * Dialogs and buttons are client islands shared by the job page, Home and My jobs;
 * sections are server components fed by `getJobPageSimple`.
 */
export { simpleJobApi, simpleJobPath, type ApproveBody, type AskForChangesBody, type EditorChoice, type FinishedLinkInput, type ReopenBody, type SendForCheckingBody } from "./api";
export { useConflict } from "./use-conflict";
export { AssignEditorDialog, EditorDeskLine, type AssignEditorDialogProps } from "./assign-editor-dialog";
export { SendForCheckingForm, SendForCheckingDialog, type SendForCheckingFormProps, type SendForCheckingDialogProps } from "./send-for-checking";
export { ApproveButton, SendToClientButton, type ApproveButtonProps, type SendToClientButtonProps } from "./approve-button";
export { AskForChangesDialog, type AskForChangesDialogProps } from "./ask-for-changes-dialog";
export { ReopenDialog, type ReopenDialogProps } from "./reopen-dialog";
export { CancelJobDialog, DeclineJobDialog, TakeBackDialog, RestoreButton, StartEditingButton } from "./simple-dialogs";
export { NextStepCard, RequestNote, type NextStepCardProps } from "./next-step-card";
export { JobMenu, type JobMenuProps } from "./job-menu";
export { JobHeaderSimple, type JobHeaderSimpleProps } from "./job-header-simple";
export { FilesSection, type FilesSectionProps } from "./files-section";
export { AddLinkInline, type AddLinkInlineProps } from "./add-link-inline";
export { InstructionsSection, type InstructionsSectionProps } from "./instructions-section";
export { InstructionComposer, type InstructionComposerProps } from "./instruction-composer";
export { ChangesAskedSection, type ChangesAskedSectionProps } from "./changes-asked-section";
export { MessagesThread, MESSAGE_COMPOSER_ID, focusMessageComposer, type MessagesThreadProps } from "./messages-thread";
export { PrivateNotes, type PrivateNotesProps } from "./private-notes";
export { FromClient, type FromClientProps } from "./from-client";
export { WhoDidWhat, type WhoDidWhatProps } from "./who-did-what";
export { SideColumn, type SideColumnProps } from "./side-column";
export { ShareProgressButton, type ShareProgressButtonProps } from "./share-progress-button";
export { EditJobSimpleForm, type EditJobSimpleFormProps, type SimpleEditableJob, type SimpleEditPermissions } from "./edit-job-simple-form";
