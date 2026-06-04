import { useEffect, useState } from 'react';
import { mapUrlFor } from '../data/maps';
import { loadRun } from '../data';
import { MapView, type FlowSegmentLite } from './MapView';

// Dashboard shell over <MapView>: resolves the per-run map URL via the
// runs manifest and fetches the per-run JSON to extract flow segments for
// overlays. The hub mounts MapView differently — each shell is only
// responsible for URL resolution + flow lookup.

type RunWithFlow = { flow?: { beltSegments?: FlowSegmentLite[] } };

export function RunMapPlayer({ runName }: { runName: string }) {
  const mapUrl = mapUrlFor(runName);
  const [flowSegments, setFlowSegments] = useState<FlowSegmentLite[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setFlowSegments(undefined);
    loadRun(runName).then(r => {
      if (!cancelled) setFlowSegments((r as unknown as RunWithFlow).flow?.beltSegments);
    });
    return () => { cancelled = true; };
  }, [runName]);

  if (!mapUrl) {
    return <div className="run-map-player run-map-error">no map data for {runName}</div>;
  }
  const spritesUrl = `${import.meta.env.BASE_URL}game-data/map-sprites.json`;
  return <MapView mapUrl={mapUrl} spritesUrl={spritesUrl} flowSegments={flowSegments} />;
}
