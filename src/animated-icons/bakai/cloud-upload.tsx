/* Cloud Upload — Phosphor "cloud-arrow-up" (fill). 256 viewBox.

   In the fill weight the up-arrow is a knockout in the solid cloud, so it
   lives in a MASK: the cloud path is drawn whole and the black arrow shape
   (the source's own arrow subpath, made absolute) punches it out. Rest is
   the mask sitting at identity — the verbatim icon.

   The gesture is an upload stream: the arrow accelerates up and leaves
   through the top of the cloud (as the knockout crosses the outline it
   reads as the arrow punching out), and while nothing is visible it re-arms
   150u BELOW, then rises back into the cloud from underneath — appearing
   exactly as it enters the solid, no opacity — and eases into its seat.
   At ±150 the arrow (y83-184 at rest) is fully clear of the cloud's ink
   (y40-216), both proven invisible states. Departure is the gravity-flip
   ease-in; arrival is a long ease-out (420ms) so the landing is what you
   watch. */

import { useId } from "react";

const CU_CLOUD =
    "M247.93,124.52C246.11,77.54,207.07,40,160.06,40A88.1,88.1,0,0,0,81.29,88.67h0A87.48,87.48,0,0,0,72,127.73,8.18,8.18,0,0,1,64.57,136,8,8,0,0,1,56,128a103.66,103.66,0,0,1,5.34-32.92,4,4,0,0,0-4.75-5.18A64.09,64.09,0,0,0,8,152c0,35.19,29.75,64,65,64H160A88.09,88.09,0,0,0,247.93,124.52Z";
const CU_ARROW =
    "M197.66,133.66a8,8,0,0,1-11.32,0L168,115.31V176a8,8,0,0,1-16,0V115.31l-18.34,18.35a8,8,0,0,1-11.32-11.32l32-32a8,8,0,0,1,11.32,0l32,32A8,8,0,0,1,197.66,133.66Z";

export function CloudArrowUpLive({ size = 16, className, converted }: { size?: number; className?: string; converted?: boolean }) {
    const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
    const m = `cuMask${uid}`;
    const clip = `cuClip${uid}`;
    return (
        <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" className={className}>
            {converted ? (
                <>
                    <defs><clipPath id={clip}><path d={CU_CLOUD} /></clipPath></defs>
                    <path d={CU_CLOUD} fill="none" stroke="var(--converted-ink)" strokeWidth="16" strokeLinejoin="round" />
                    <g clipPath={`url(#${clip})`}><path className="cu-arrow" d={CU_ARROW} fill="var(--converted-ink)" /></g>
                </>
            ) : (
                <>
                    <mask id={m} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
                        <rect x="0" y="0" width="256" height="256" fill="#fff" />
                        <path className="cu-arrow" d={CU_ARROW} fill="#000" />
                    </mask>
                    <path d={CU_CLOUD} mask={`url(#${m})`} />
                </>
            )}
        </svg>
    );
}
