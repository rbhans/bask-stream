import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import com.sun.source.util.JavacTask;

// Parse only. Does not resolve Niagara types, generate classes, or build a module.
class SyntaxCheck {
  public static void main(String[] args) throws Exception {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
    List<File> sources = new ArrayList<>();
    try (java.util.stream.Stream<Path> paths = Files.walk(Path.of(args[0]))) {
      paths.filter(p -> p.toString().endsWith(".java") && !p.getFileName().toString().startsWith("._")).forEach(p -> sources.add(p.toFile()));
    }
    try (StandardJavaFileManager files = compiler.getStandardFileManager(diagnostics, null, null)) {
      JavacTask task = (JavacTask)compiler.getTask(null, files, diagnostics,
          Arrays.asList("-proc:none", "-source", "8"), null, files.getJavaFileObjectsFromFiles(sources));
      task.parse();
      for (Diagnostic<?> diagnostic : diagnostics.getDiagnostics()) {
        if (diagnostic.getKind() == Diagnostic.Kind.ERROR) throw new AssertionError(diagnostic);
      }
    }
    System.out.println("PASS: Java 8 syntax parsed for " + sources.size() + " source files; no type checking or module build");
  }
}
