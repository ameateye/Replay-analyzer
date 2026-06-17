import { useEffect, useState } from 'react';
import { mapUrlFor } from '../data/maps';
import { loadRun } from '../data';
import { MapView, type FlowSegmentLite, type FlowClusterLite } from './MapView';

// Dashboard shell over <MapView>: resolves the per-run map URL via the
// runs manifest and fetches the per-run JSON to extract flow segments +
// clusters for overlays. The hub mounts MapView differently — each shell is
// only responsible for URL resolution + flow lookup.

type RunWithFlow = { flow?: { beltSegments?: FlowSegmentLite[]; clusters?: FlowClusterLite[] } };

export function RunMapPlayer({ runName }: { runName: string }) {
  const mapUrl = mapUrlFor(runName);
  const [flowSegments, setFlowSegments] = useState<FlowSegmentLite[] | undefined>(undefined);
  const [clusters, setClusters] = useState<FlowClusterLite[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setFlowSegments(undefined);
    setClusters(undefined);
    loadRun(runName).then(r => {
      if (cancelled) return;
      const flow = (r as unknown as RunWithFlow).flow;
      setFlowSegments(flow?.beltSegments);
      setClusters(flow?.clusters);
    });
    return () => { cancelled = true; };
  }, [runName]);

  if (!mapUrl) {
    return <div className="run-map-player run-map-error">no map data for {runName}</div>;
  }
  const spritesUrl = `${import.meta.env.BASE_URL}game-data/map-sprites.json`;
  return <MapView mapUrl={mapUrl} spritesUrl={spritesUrl} fitMode="viewport" flowSegments={flowSegments} clusters={clusters} />;
}
