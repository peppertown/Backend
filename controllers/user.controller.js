const bcrypt = require("bcrypt");
const db = require("../utils/db");
const jwt = require("jsonwebtoken");
const { uploadToS3 } = require('../utils/s3');

exports.registerUser = async (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username) {
    return res
      .status(400)
      .json({ success: false, message: "아이디를 입력해주세요!" });
  }
  if (!password) {
    return res
      .status(400)
      .json({ success: false, message: "비밀번호를 입력해주세요!" });
  }
  if (!nickname) {
    return res
      .status(400)
      .json({ success: false, message: "닉네임을 입력해주세요!" });
  }

  try {
    // ID 중복 체크
    const result = await db.execute("SELECT * FROM users WHERE username = ?", [
      username,
    ]);
    const existingUser = Array.isArray(result) ? result[0] : []; // 배열인지 확인
    if (existingUser.length > 0) {
      return res
        .status(400)
        .json({ success: false, message: "이미 존재하는 ID입니다." });
    }

    // 태그 번호 계산
    const maxTagResult = await db.execute(
      "SELECT MAX(tag_number) AS maxTagNumber FROM users"
    );
    const rows = Array.isArray(maxTagResult) ? maxTagResult[0] : [];
    const maxTagNumber =
      rows.length > 0 && rows[0]?.maxTagNumber ? rows[0].maxTagNumber : 0;
    const tagNumber = maxTagNumber + 1;
    const tag = `#${String(tagNumber).padStart(2, "0")}`;

    // 비밀번호 해싱
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 사용자 삽입
    await db.execute(
      "INSERT INTO users (username, password, nickname, tag_number, tag) VALUES (?, ?, ?, ?, ?)",
      [username, hashedPassword, nickname, tagNumber, tag]
    );

    res.status(201).json({
      success: true,
      message: "회원가입 성공",
      data: { username, nickname, tag },
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
};

// 로그인 컨트롤러
exports.loginUser = async (req, res) => {
  const { username, password } = req.body;

  // 필드 확인
  if (!username) {
    return res
      .status(400)
      .json({ success: false, message: "아이디를 입력해주세요!" });
  }
  if (!password) {
    return res
      .status(400)
      .json({ success: false, message: "비밀번호를 입력해주세요!" });
  }

  try {
    // 사용자 조회
    const [result] = await db.execute(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );
    const user = Array.isArray(result) && result.length > 0 ? result[0] : null;

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "존재하지 않는 사용자입니다." });
    }

    // 비밀번호 확인
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "비밀번호가 일치하지 않습니다." });
    }

    // JWT 생성
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      {
        expiresIn: "1h",
      }
    );

    // 응답
    res.status(200).json({
      success: true,
      message: "로그인 성공",
      token,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
};

// 사용자 정보 조회 컨트롤러
exports.getUserInfo = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await db.execute(
      "SELECT nickname, profile_icon AS icon, tag FROM users WHERE id = ?",
      [userId]
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "사용자를 찾을 수 없습니다." });
    }

    res.status(200).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ success: false, message: "서버 오류가 발생했습니다." });
  }
};

exports.changeNickname = async (req, res) => {
  try {
    const id = req.user.id;
    const { nickname } = req.body;

    // 닉네임 입력값이 없을 시 예외처리
    if (!nickname) {
      return res
          .status(400)
          .json({ success: false, message: "변경할 닉네임을 입력해주세요" });
    }

    const [pastUserData] = await db.execute(
        `SELECT nickname FROM users WHERE id=?`,
        [id]
    );

    // 현재 닉네임과 동일한 닉네임을 입력했을 시 예외처리
    if (pastUserData.length && pastUserData[0].nickname === nickname) {
      return res
          .status(400)
          .json({ success: false, message: "동일한 닉네임 입니다." });
    }

    const sql = `UPDATE users SET nickname=? WHERE id=?`;
    const params = [nickname, id];

    const [result] = await db.execute(sql, params);

    // 업데이트 성공 여부 확인
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    res.status(200).json({ success: true, message: "닉네임이 변경되었습니다." });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "서버 오류가 발생했습니다.",
    });
  }
};

// 아이콘 수정
exports.updateProfileIcon = async (req, res) => {
  try {
    const userId = req.user.id; // 인증 미들웨어에서 추출
    const file = req.file; // multer가 처리한 파일

    if (!file) {
      return res.status(400).json({ success: false, message: '파일이 제공되지 않았습니다.' });
    }

    // S3에 파일 업로드
    const profileIconUrl = await uploadToS3(file);

    // DB에 저장
    const sql = `UPDATE users SET profile_icon = ? WHERE id = ?`;
    const params = [profileIconUrl, userId];
    const [result] = await db.execute(sql, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '유저를 찾을 수 없습니다.' });
    }
    console.log(req.file); // 업로드된 파일 데이터
    console.log(req.body); // 요청 Body 데이터

    res.status(200).json({
      success: true,
      message: '프로필 아이콘이 성공적으로 업데이트되었습니다.',
      profileIcon: profileIconUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
};