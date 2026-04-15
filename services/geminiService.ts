
import { GoogleGenAI, Type } from "@google/genai";
import { ExtractedDocument } from "../types";
import { PDFDocument } from "pdf-lib";

const API_LIMIT_BYTES = 30 * 1024 * 1024; 
const PAGES_PER_CHUNK = 15; 

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Lỗi khi đọc file."));
  });
};

const documentSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      docType: {
        type: Type.STRING,
        description: "Loại văn bản (Quyết định, Thông báo, Công văn, Kế hoạch...)",
      },
      symbol: {
        type: Type.STRING,
        description: "Số ký hiệu văn bản. Nếu không có để trống.",
      },
      date: {
        type: Type.STRING,
        description: "Ngày tháng văn bản (định dạng dd/mm/yyyy).",
      },
      summary: {
        type: Type.STRING,
        description: "Trích yếu nội dung tiếp nối sau tên loại văn bản.",
      },
      authority: {
        type: Type.STRING,
        description: "Cơ quan ban hành văn bản trực tiếp.",
      },
      startPage: {
        type: Type.STRING,
        description: "Số trang bắt đầu (là số nằm phía bên góc phải văn bản, được viết bằng bút chì). ĐỊNH DẠNG: Nếu số từ 1 đến 9, phải thêm số 0 ở trước (Ví dụ: '01', '02').",
      }
    },
    required: ["docType", "symbol", "date", "summary", "authority", "startPage"],
  },
};

const processChunk = async (ai: GoogleGenAI, base64Data: string): Promise<ExtractedDocument[]> => {
  const systemInstruction = `Bạn là chuyên gia văn thư lưu trữ. Nhiệm vụ của bạn là bóc tách TOÀN BỘ các văn bản có trong tệp PDF.
TUYỆT ĐỐI KHÔNG BỎ SÓT BẤT KỲ VĂN BẢN NÀO, ĐẶC BIỆT CHÚ Ý CÁC VĂN BẢN NHƯ "SƠ YẾU LÝ LỊCH", "PHIẾU ĐẢNG VIÊN", "ĐƠN TỪ"... ĐÂY CŨNG LÀ CÁC VĂN BẢN ĐỘC LẬP CẦN ĐƯỢC BÓC TÁCH.

QUY TẮC NGHIÊM NGẶT:
1. Cơ quan ban hành (authority): 
   - KHÔNG viết in hoa tất cả các chữ cái.
   - CHỈ viết hoa chữ cái đầu tiên và các từ là tên riêng (Ví dụ: 'Ủy ban Kiểm tra Huyện ủy Đắk R'lấp' thay vì 'ỦY BAN KIỂM TRA...').
   - PHIẾU PHÂN TÍCH CHẤT LƯỢNG VÀ ĐÁNH GIÁ, XẾP LOẠI: Cơ quan ban hành là Tên chủ thể tham gia đánh giá, xếp loại.
   - CÁC VĂN BẢN NHƯ: BẢN TỰ KIỂM ĐIỂM, KIỂM ĐIỂM, BẢN TỰ NHẬN XÉT, BẢN KÊ KHAI TÀI SẢN THU NHẬP, SƠ YẾU LÝ LỊCH: Cơ quan ban hành (tác giả văn bản) chính là Tên cá nhân có trong văn bản (người thực hiện/kê khai).
2. Loại văn bản & Trích yếu:
   - TUYỆT ĐỐI KHÔNG lặp lại tên loại văn bản (docType) trong phần trích yếu (summary). Ví dụ: Nếu docType là "Báo cáo", thì summary chỉ ghi "kết quả công tác...", KHÔNG ghi "báo cáo kết quả công tác...". Nếu docType là "Quyết định", summary ghi "về việc...", KHÔNG ghi "quyết định về việc...". Hãy tự động cắt bỏ tên loại văn bản ở đầu trích yếu.
   - Bắt đầu trích yếu bằng chữ thường (trừ tên riêng).
   - PHIẾU PHÂN TÍCH CHẤT LƯỢNG VÀ ĐÁNH GIÁ, XẾP LOẠI: Phải thêm cụm từ "của [Tên chủ thể tham gia đánh giá]" vào cuối trích yếu. KHÔNG thêm tên tổ chức Đảng được đánh giá.
   - VĂN BẢN NHẬN XÉT, ĐÁNH GIÁ CÁN BỘ: Bắt buộc lấy cả những nội dung nằm trong dấu ngoặc đơn () ngay phía dưới tiêu đề văn bản để đưa vào phần trích yếu nội dung.
   - BẢN KÊ KHAI TÀI SẢN THU NHẬP, SƠ YẾU LÝ LỊCH: Phần trích yếu nội dung CHỈ ghi "của đồng chí [Tên cá nhân]". TUYỆT ĐỐI KHÔNG ghi chức danh ứng cử, chức vụ hay các nội dung khác vào phần trích yếu.
   - QUY TẮC TRÍCH XUẤT TÊN CÁ NHÂN: CHỈ lấy tên các cá nhân được nhắc đến trong nội dung văn bản về các việc như: điều động, bổ nhiệm, chỉ định, chuẩn y các chức danh, kết nạp đảng viên, nâng lương, tự nhận xét, đánh giá, sơ yếu lý lịch... Các loại văn bản khác KHÔNG lấy tên cá nhân.
   - QUY TẮC SỐ LƯỢNG CÁ NHÂN: Đối với các văn bản thuộc nhóm trên, nếu từ 3 cá nhân trở xuống thì liệt kê tên (bằng cách thêm cụm từ "đối với đồng chí [Tên cá nhân]" vào cuối trích yếu), nếu trên 3 cá nhân thì KHÔNG liệt kê tên.
   - CHÚ Ý QUAN TRỌNG: Tuyệt đối không để lặp lại từ trong phần trích yếu nội dung (nếu trong trích yếu đã có sẵn tên người đó hoặc chữ "đối với", phải điều chỉnh để câu văn tự nhiên, không bị lặp từ).
3. Số hiệu: Ghi đầy đủ (Ví dụ: 12-QĐ/UBKTHU). KHÔNG THÊM dấu nháy đơn '.
4. Ngày tháng: Định dạng dd/mm/yyyy.
5. Số trang bắt đầu: Trích xuất số bút chì ghi ở góc trên bên phải trang đầu mỗi văn bản. ĐỊNH DẠNG: Nếu số từ 1 đến 9, phải thêm số 0 ở trước (Ví dụ: '01', '02').`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "application/pdf", data: base64Data } },
            { text: "Phân tích và trích xuất danh sách văn bản sang JSON." }
          ],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: documentSchema,
      },
    });

    const result = response.text;
    if (!result) return [];
    
    const cleanJson = result.replace(/```json/g, '').replace(/```/g, '').trim();
    const rawData: ExtractedDocument[] = JSON.parse(cleanJson);

    // Hậu xử lý: Đảm bảo số trang có số 0 phía trước nếu từ 1-9
    rawData.forEach(doc => {
      if (doc.startPage && /^\d$/.test(doc.startPage.toString().trim())) {
        doc.startPage = `0${doc.startPage.toString().trim()}`;
      }
      
      // Hậu xử lý: Xóa tên loại văn bản ở đầu trích yếu nếu AI vẫn trả về
      if (doc.docType && doc.summary) {
        const docTypeLower = doc.docType.toLowerCase().trim();
        const summaryLower = doc.summary.toLowerCase().trim();
        if (summaryLower.startsWith(docTypeLower)) {
          doc.summary = doc.summary.substring(docTypeLower.length).trim();
          // Viết thường chữ cái đầu tiên sau khi cắt
          if (doc.summary.length > 0) {
            doc.summary = doc.summary.charAt(0).toLowerCase() + doc.summary.slice(1);
          }
        }
      }
    });

    return rawData;
  } catch (e: any) {
    console.error("Gemini processing error:", e);
    throw e;
  }
};

export const extractDataFromPdf = async (file: File): Promise<ExtractedDocument[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const totalPdfPages = pdfDoc.getPageCount();

  let allResults: ExtractedDocument[] = [];

  try {
    if (file.size <= API_LIMIT_BYTES) {
      const base64Data = await fileToBase64(file);
      allResults = await processChunk(ai, base64Data);
    } else {
      for (let i = 0; i < totalPdfPages; i += PAGES_PER_CHUNK) {
        const newDoc = await PDFDocument.create();
        const end = Math.min(i + PAGES_PER_CHUNK, totalPdfPages);
        const pagesToCopy = Array.from({ length: end - i }, (_, k) => i + k);
        const copiedPages = await newDoc.copyPages(pdfDoc, pagesToCopy);
        copiedPages.forEach(page => newDoc.addPage(page));
        const pdfBytes = await newDoc.save();
        const base64Chunk = uint8ArrayToBase64(pdfBytes);
        const chunkResults = await processChunk(ai, base64Chunk);
        allResults = [...allResults, ...chunkResults];
      }
    }

    // HẬU XỬ LÝ: Tính toán pageRange
    return allResults.map((doc, index, array) => {
      const nextDoc = array[index + 1];
      const startPage = doc.startPage;
      let endPage: number | null = null;
      
      if (nextDoc) {
        endPage = Number(nextDoc.startPage) - 1;
      }

      // Logic: Số trang bắt đầu-Số trang kết thúc
      let displayRange = `'${startPage}`;
      if (endPage !== null && endPage > Number(startPage)) {
        const endPageStr = endPage < 10 ? `0${endPage}` : `${endPage}`;
        displayRange = `'${startPage}-${endPageStr}`;
      }

      let formattedDate = doc.date ? (doc.date.startsWith("'") ? doc.date.substring(1) : doc.date) : "";
      if (formattedDate) {
        const parts = formattedDate.split('/');
        if (parts.length === 3) {
          let [day, month, year] = parts;
          const monthNum = parseInt(month, 10);
          if (!isNaN(monthNum)) {
            if (monthNum >= 1 && monthNum <= 3) {
              month = monthNum.toString().padStart(2, '0');
            } else if (monthNum >= 4 && monthNum <= 9) {
              month = monthNum.toString();
            }
            formattedDate = `${day}/${month}/${year}`;
          }
        }
        formattedDate = `'${formattedDate}`;
      }

      return {
        ...doc,
        date: formattedDate,
        pageRange: displayRange
      };
    });
  } catch (error: any) {
    throw new Error(error.message || "Lỗi xử lý PDF.");
  }
};
