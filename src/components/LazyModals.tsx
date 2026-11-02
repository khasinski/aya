import { lazy, Suspense, type ComponentProps } from "react";
const LazyTeamsModal = lazy(() => import("./TeamsModal").then(module => ({ default: module.TeamsModal })));
export function TeamsModal(props: ComponentProps<typeof LazyTeamsModal>) { return <Suspense fallback={null}><LazyTeamsModal {...props} /></Suspense>; }
const LazySearchModal = lazy(() => import("./SearchModal").then(module => ({ default: module.SearchModal })));
export function SearchModal(props: ComponentProps<typeof LazySearchModal>) { return <Suspense fallback={null}><LazySearchModal {...props} /></Suspense>; }
const LazySettingsModal = lazy(() => import("./SettingsModal").then(module => ({ default: module.SettingsModal })));
export function SettingsModal(props: ComponentProps<typeof LazySettingsModal>) { return <Suspense fallback={null}><LazySettingsModal {...props} /></Suspense>; }
const LazyUsageDashboard = lazy(() => import("./UsageDashboard").then(module => ({ default: module.UsageDashboard })));
export function UsageDashboard(props: ComponentProps<typeof LazyUsageDashboard>) { return <Suspense fallback={null}><LazyUsageDashboard {...props} /></Suspense>; }
