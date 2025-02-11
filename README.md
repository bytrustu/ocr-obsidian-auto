### 📌 **Obsidian OCR 자동화 프로젝트**
 
AI OCR을 활용해 **이미지를 저장하는 순간 텍스트를 추출**하고,  
Obsidian 노트에 자동으로 정리하면 검색과 활용이 훨씬 쉬워집니다.  

이 프로젝트는 **Obsidian, CLOVA OCR, OpenAI GPT**를 결합하여,
이미지 속 텍스트를 **자동으로 분석 → 정리 → 노트에 삽입**하는 자동화 프로세스를 구현합니다.  

---

## 🚀 **실행 방법**

### 1️⃣ **설치 및 환경 설정**

1. **Node.js** 설치
2. `.env` 파일을 생성하고 다음 값을 입력

    ```bash
    CLOVA_API_URL=YOUR_CLOVA_API_URL
    CLOVA_SECRET_KEY=YOUR_CLOVA_SECRET_KEY
    OPENAI_API_KEY=YOUR_OPENAI_API_KEY
    OBSIDIAN_VAULT_PATH=/your/obsidian/vault/path
    ```

3. 패키지 설치

    ```bash
    pnpm install
    ```


### 2️⃣ **실행 및 이미지 감시**

```bash
pnpm start
```

- Obsidian Vault 내 **_MD5 폴더**를 감시
- 새로운 이미지가 감지되면
    1. **CLOVA OCR**로 텍스트 추출
    2. **GPT로 정리 및 요약**
    3. **Obsidian 노트에 자동 삽입**

### 3️⃣ **결과 확인**

- 이미지가 포함된 노트를 열면,`%% ... %%` **숨김 블록** 안에 OCR 분석 결과가 자동으로 추가됩니다.
- 추출된 텍스트는 **한 줄 요약, 정리된 문단, 태그**까지 포함됩니다.