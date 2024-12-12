const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { upload } = require("../middleware/upload");
const crypto = require("crypto");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const path = require("path");

// S3 클라이언트 설정
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 안전한 파일명 생성 함수
function generateSafeFilename(originalFilename) {
  const ext = path.extname(originalFilename || "").toLowerCase();
  const timestamp = Date.now();
  const randomBytes = crypto.randomBytes(8).toString("hex");
  return `${timestamp}_${randomBytes}${ext}`;
}

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const validationErrors = [];

    if (!name || name.trim().length === 0) {
      validationErrors.push({ field: "name", message: "이름을 입력해주세요." });
    } else if (name.length < 2) {
      validationErrors.push({ field: "name", message: "이름은 2자 이상이어야 합니다." });
    }

    if (!email) {
      validationErrors.push({ field: "email", message: "이메일을 입력해주세요." });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({ field: "email", message: "올바른 이메일 형식이 아닙니다." });
    }

    if (!password) {
      validationErrors.push({ field: "password", message: "비밀번호를 입력해주세요." });
    } else if (password.length < 6) {
      validationErrors.push({ field: "password", message: "비밀번호는 6자 이상이어야 합니다." });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ success: false, errors: validationErrors });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "이미 가입된 이메일입니다." });
    }

    const newUser = new User({ name, email, password, profileImage: "" });
    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: "회원가입이 완료되었습니다.",
      user: { id: newUser._id, name: newUser.name, email: newUser.email, profileImage: newUser.profileImage },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ success: false, message: "회원가입 처리 중 오류가 발생했습니다." });
  }
};

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "프로필 조회 중 오류가 발생했습니다." });
  }
};

// 프로필 업데이트 (이름 및 비밀번호 변경)
exports.updateProfile = async (req, res) => {
  try {
    const { name, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id).select("+password");

    if (!user) {
      return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: "이름을 입력해주세요." });
    }

    user.name = name.trim();

    // 비밀번호 변경 처리
    if (currentPassword || newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: "현재 비밀번호를 입력해주세요." });
      }

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ success: false, message: "현재 비밀번호가 일치하지 않습니다." });
      }

      if (newPassword && newPassword.length >= 6) {
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
      } else if (newPassword) {
        return res.status(400).json({ success: false, message: "새 비밀번호는 6자 이상이어야 합니다." });
      }
    }

    await user.save();

    res.json({
      success: true,
      message: "프로필이 업데이트되었습니다.",
      user: { id: user._id, name: user.name, email: user.email, profileImage: user.profileImage },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ success: false, message: "프로필 업데이트 중 오류가 발생했습니다." });
  }
};

// 프로필 이미지 업로드 (S3 업로드)
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "이미지가 제공되지 않았습니다.",
      });
    }

    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024;
    if (fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        message: "파일 크기는 5MB를 초과할 수 없습니다.",
      });
    }

    if (!fileType.startsWith("image/")) {
      return res.status(400).json({
        success: false,
        message: "이미지 파일만 업로드할 수 있습니다.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "사용자를 찾을 수 없습니다." });
    }

    if (user.profileImage) {
      const oldKey = path.basename(user.profileImage);
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: oldKey }));
      } catch (error) {
        console.error("Old profile image delete error:", error);
      }
    }

    const safeFilename = generateSafeFilename(req.file.originalname);
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: safeFilename,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: "public-read",
    };

    const parallelUploads3 = new Upload({
      client: s3,
      params: uploadParams,
    });

    parallelUploads3.on("httpUploadProgress", (progress) => {
      console.log(`프로필 이미지 업로드 진행: ${progress.loaded} / ${progress.total}`);
    });

    await parallelUploads3.done();

    const s3Url = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${safeFilename}`;
    user.profileImage = s3Url;
    await user.save();

    res.json({ success: true, message: "프로필 이미지가 업데이트되었습니다.", imageUrl: user.profileImage });
  } catch (error) {
    console.error("Profile image upload error:", error);
    res.status(500).json({ success: false, message: "이미지 업로드 중 오류가 발생했습니다." });
  }
};

// 프로필 이미지 삭제 (S3 삭제)
exports.deleteProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    if (user.profileImage) {
      const imageKey = path.basename(user.profileImage);
      if (imageKey && imageKey !== "") {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: imageKey }));
        } catch (error) {
          console.error("Profile image delete error:", error);
        }
      }

      user.profileImage = "";
      await user.save();
    }

    res.json({
      success: true,
      message: "프로필 이미지가 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Delete profile image error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 이미지 삭제 중 오류가 발생했습니다.",
    });
  }
};

// 회원 탈퇴 (S3 이미지 삭제)
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    if (user.profileImage) {
      const imageKey = path.basename(user.profileImage);
      if (imageKey && imageKey !== "") {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: imageKey }));
        } catch (error) {
          console.error("Profile image delete error:", error);
        }
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: "회원 탈퇴가 완료되었습니다.",
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "회원 탈퇴 처리 중 오류가 발생했습니다.",
    });
  }
};

module.exports = exports;