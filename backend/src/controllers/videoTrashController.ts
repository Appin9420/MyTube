/**
 * Recycle bin endpoints: list / restore / permanently purge videos that were
 * moved to the trash by the delete flow.
 */

import { Request, Response } from "express";
import { successResponse } from "../utils/response";
import {
  listTrash as listTrashEntries,
  purgeTrashItem as purgeTrashEntry,
  restoreFromTrash,
} from "../services/storageService/videoTrash";

const asId = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] : value;

export const listTrash = async (_req: Request, res: Response) => {
  res.json(successResponse({ items: listTrashEntries() }));
};

export const restoreTrashItem = async (req: Request, res: Response) => {
  const { video } = restoreFromTrash(asId(req.params.id));
  res.json(successResponse({ video }, "Video restored from trash"));
};

export const purgeTrashItem = async (req: Request, res: Response) => {
  const removed = purgeTrashEntry(asId(req.params.id));
  res.json(successResponse({ removed }, "Trash item permanently deleted"));
};
