import { z } from 'zod'

export const DOCTOR_SEVERITIES = ['info', 'warning', 'error'] as const
export const doctorSeveritySchema = z.enum(DOCTOR_SEVERITIES)
export type DoctorSeverity = z.infer<typeof doctorSeveritySchema>

export const DOCTOR_OUTCOMES = ['pass', 'issue', 'skipped'] as const
export const doctorOutcomeSchema = z.enum(DOCTOR_OUTCOMES)
export type DoctorOutcome = z.infer<typeof doctorOutcomeSchema>

export const doctorCheckSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  outcome: doctorOutcomeSchema,
  severity: doctorSeveritySchema,
  summary: z.string().min(1),
  detail: z.string().min(1).optional(),
  relatedIds: z.array(z.string().min(1)).optional(),
})
export type DoctorCheck = z.infer<typeof doctorCheckSchema>

export const doctorReportSchema = z.strictObject({
  generatedAt: z.string().datetime(),
  workspaceId: z.string().min(1).optional(),
  severity: doctorSeveritySchema,
  issueCount: z.number().int().nonnegative(),
  checks: z.array(doctorCheckSchema),
})
export type DoctorReport = z.infer<typeof doctorReportSchema>

export const runDoctorRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
})
export type RunDoctorRequest = z.infer<typeof runDoctorRequestSchema>
