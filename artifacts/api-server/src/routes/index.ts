import { Router, type IRouter } from "express";
import healthRouter from "./health";
import segmentRouter from "./segment";
import ttsRouter from "./tts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(segmentRouter);
router.use(ttsRouter);

export default router;
