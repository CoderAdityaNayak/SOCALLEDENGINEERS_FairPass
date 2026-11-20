from django.shortcuts import render

def index(request):
    return render(request, 'main/index.html')

def about(request):
    return render(request, 'main/index.html')

    
def org(request):
    return render(request, 'main/org.html')
    
def book(request):
    return render(request, 'main/book.html')