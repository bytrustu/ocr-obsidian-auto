const getGptPrompt = ({
  ocrTexts,
  noteTitle,
  oldFileName,
  categoryPath,
}) => `
아래 정보를 활용해, 네 가지 결과물을 JSON 형태로 한꺼번에 만들어주세요.

[입력 데이터]
1) OCR 텍스트:
"${ocrTexts}"

2) 노트 제목: "${noteTitle}"
3) 현재 파일명: "${oldFileName}"
4) 폴더 경로(최대 3뎁스): "${categoryPath}"

[요구사항]
1) improvedText:
   - 'OCR 텍스트'는 OCR로 추출된 (x,y,text) 리스트를 JSON으로 나타낸 것입니다.
  - 'OCR 텍스트'의 좌표가 파악해서 섹션, 리스트 개념 고려해 깔끔한 마크다운으로 만들어주세요 (###, - 등 사용)
  - 슬라이드 우측 상단 등 본문과 무관한 발표 주체나 명칭은 포함하지 않습니다
  - 결과에는 좌표를 포함하지 않고, 텍스트만 포함되어야 합니다.
   - 코드 블록(\`\`\`)으로 감싸주세요
2) oneLineSummary:
   - improvedText를 한 문장으로 요약
3) newFileName:
   - "노트명_요약" 식의 한글 파일명 (확장자 제외, 50자 이하)
   - 공백/특수문자 -> '_' 치환
4) categoryTag:
   - categoryPath를 해석해 "#Study/세션" 등 태그 형태로
   - 없으면 ""

[출력 형식]
JSON만 정확히 반환(추가 말X).
{
  "improvedText": "...",
  "oneLineSummary": "...",
  "newFileName": "...",
  "categoryTag": "..."
}`;

export { getGptPrompt }; 