import { useSyncExternalStore } from 'react';
/** The application owns start/dispose, including across StrictMode remounts. */
export function useSessionView(view) {
    return useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
}
export function useSessionListView(view) {
    return useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
}
export function useWhipConnection(client) {
    return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
//# sourceMappingURL=react.js.map