// backend/routes/api/files.js
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const fileController = require('../../controllers/fileController');
const { upload, errorHandler } = require('../../middleware/upload');

// 파일 업로드
router.post(
  '/upload',
  auth,
  upload.single('file'),
  fileController.uploadFile, // 컨트롤러를 먼저 호출
  errorHandler              // 오류 핸들러는 컨트롤러 후에 위치
);

// 파일 다운로드
router.get(
  '/download/:filename',
  auth,
  fileController.downloadFile
);

// 파일 보기 (미리보기용)
router.get(
  '/view/:filename',
  auth,
  fileController.viewFile
);

// 파일 삭제
router.delete(
  '/delete/:id', // 경로를 '/delete/:id'로 명확히 변경 (선택 사항)
  auth,
  fileController.deleteFile
);

module.exports = router;