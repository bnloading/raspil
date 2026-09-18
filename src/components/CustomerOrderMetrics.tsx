import type { Order } from "../types/domain";
import { orderTiles } from "../lib/orderTiles";
import { IconOrders, IconPvc, IconLayers } from "./layout/icons";
import { formatMdfArea } from "../lib/mdfJournal";

export function CustomerOrderMetrics({ order }: { order: Order }) {
  const tiles = orderTiles(order);
  return <div className="corder-tiles">{order.orderKind === "mdf_wrap" ? <span className="corder-tile"><IconLayers className="corder-tile-icon" /><b>{formatMdfArea(order.mdfAreaM2)}</b><small>{order.mdfFilmColor || "МДФ"}</small></span> : <>
    <span className="corder-tile"><IconOrders className="corder-tile-icon" /><b>{tiles.sheets}</b><small>лист</small></span>
    <span className="corder-tile"><IconPvc className="corder-tile-icon" /><b>{tiles.pvcMeters} м</b><small>ПВХ</small></span>
    <span className="corder-tile"><IconLayers className="corder-tile-icon" /><b>{tiles.hdfSheets}</b><small>ХДФ</small></span>
  </>}</div>;
}
