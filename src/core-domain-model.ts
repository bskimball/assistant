// Core domain model types (minimal recovery stub for build)
export type ISODate = string
export type ISOWeek = string

export interface DailyNutrition { date: ISODate; totals: any; mealLogs?: any[]; waterMl?: number }
export interface ProductivityTask { id: string; title: string; done: boolean; [k: string]: any }
export interface DailyFocusScore { date: ISODate; score: number }
export interface DailyPlan { date: ISODate; plan: any }
export interface DailyReflection { date: ISODate; [k: string]: any }
export interface WeeklyReview { week: ISOWeek; [k: string]: any }
export interface WeeklyNarrative { week: ISOWeek; narrative?: string }
export interface AIInteraction { id: string; date: ISODate; prompt?: string; response?: string; occurredAt?: number }
export interface VoiceTranscript { id: string; date: ISODate; transcript?: string; occurredAt?: number }
export interface VoiceIntent { [k: string]: any }
export interface ExerciseLibrary { [k: string]: any }
export interface BaseEntity { id: string; [k: string]: any }
export interface WorkoutPlan { [k: string]: any }
export interface WorkoutSession { [k: string]: any }

export const todayISO = () => new Date().toISOString().slice(0,10)
export function createProductivityTask(title: string) { return { id: crypto.randomUUID(), title, done: false } }
export const legacyTodoFromProductivityTask = (t: any) => t
// Add other helpers as needed; full impls were in original untracked file.
