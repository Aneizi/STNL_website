import "server-only";

/**
 * Public reporting API shared by web actions, dashboards and Telegram.
 * Implementations stay session-free so operator actions do not import member auth.
 * Schedule/enrolment remains separate to let team imports enrol within their transaction.
 */
export {
  currentReportingPeriod,
  enableReporting,
  ensureReportingPeriods,
  listReportingEligibility,
  listReportingPeriods,
  pauseReporting,
  PERIOD_COLUMNS,
  periodColumns,
  previewReportingPeriods,
  readReportingConfig,
  readReportingSchedule,
  recordColosseumDeadline,
  reportingEligibility,
  toDay,
  toIso,
  toPeriod,
  writeReportingConfig,
} from "./reporting-enrolment";
export type {
  ReportingConfig,
  ReportingEligibility,
  ReportingEligibilityResult,
  ReportingPeriod,
  ReportingPause,
  ReportingPeriodConflict,
  ReportingPeriodConflictReason,
  ReportingPeriodPlan,
  ReportingScheduleProblem,
} from "./reporting-enrolment";
export type { GeneratedPeriod, ReportingPeriodMode, ReportingSchedule } from "./reporting-periods";

export { MAX_BODY_LENGTH } from "./reporting-body";

export {
  createUpdate,
  editUpdate,
  voidUpdate,
  readAuthorizedUpdates,
  readCaptainUpdatePages,
  readOwnUpdates,
  readRevisionHistory,
} from "./reporting/entries";
export type {
  ReportingEntrySource,
  ReportingEntryView,
  CreateUpdateInput,
  CreateUpdateRefusal,
  CreateUpdateResult,
  EditUpdateInput,
  EditUpdateRefusal,
  EditUpdateResult,
  VoidUpdateResult,
  ReadUpdatesInput,
  ReportingEntryPage,
  OwnReportingEntry,
  OwnReportingEntryPage,
  ReportingRevision,
} from "./reporting/entries";

export {
  reportingStatus,
} from "./reporting/status";
export type {
  PeriodStatus,
  ProjectReportingStatus,
  SubmissionStatus,
  ReportingStatusInput,
} from "./reporting/status";

export {
  listPeriodOutcomes,
  closePeriod,
  correctOutcome,
} from "./reporting/outcomes";
export type {
  PeriodOutcome,
  ClosePeriodResult,
  CorrectOutcomeResult,
} from "./reporting/outcomes";
